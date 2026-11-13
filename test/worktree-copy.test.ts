import { type ChildProcess, execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

/** Copying main's database while main's app holds it open, by the fastest route the server has. */

let box: Sandbox;

const git = async (cwd: string, ...args: string[]) => {
	await promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
};

/** A main checkout under git with one Postgres service of `version`, up. */
async function project(name: string, version: 17 | 18): Promise<string> {
	const dir = await box.project(name, {
		"basepad.config.ts": configFile(`{
	name: "${name}",
	services: { db: postgres({ version: ${version} }) },
	env: ({ db }) => ({ ".env.local": { DATABASE_URL: db.url } }),
}`),
		".gitignore": "node_modules\n.env.local\n",
	});
	await git(dir, "init", "--quiet", "--initial-branch=main");
	await git(dir, "add", ".");
	await git(dir, "commit", "--quiet", "-m", "init");
	const up = await box.basepad(dir, "up");
	expect(up.stderr).toBe("");
	return dir;
}

const url = async (dir: string) => (await readEnv(dir, ".env.local")).DATABASE_URL as string;

async function sql(dir: string, query: string): Promise<string> {
	const out = await box.psql([await url(dir)], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

/** A client that connects to `dir`'s database and stays connected, as an app's pool does. */
async function holdOpen(dir: string): Promise<ChildProcess> {
	const db = await url(dir);
	const client = spawn("mise", ["exec", "postgres@18", "--", "psql", db, "-tAX"], {
		cwd: box.root,
		env: box.env,
		stdio: ["pipe", "ignore", "ignore"],
	});
	const name = new URL(db).pathname.slice(1);
	for (let i = 0; i < 100; i++) {
		const out = await box.psql(
			[db],
			`select count(*) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
		);
		if (out.stdout.trim() !== "0") return client;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("The client never connected.");
}

let main: string;
const clients: ChildProcess[] = [];

beforeAll(async () => {
	box = await sandbox();
	main = await project("t16busy", 18);
	await sql(main, "create table items (name text); insert into items values ('first')");
}, 300_000);
afterAll(async () => {
	for (const client of clients) client.kill();
	await box?.dispose();
});

test("worktree add copies main's database while a client holds it open, and main accepts connections again", async () => {
	clients.push(await holdOpen(main));
	await sql(main, "insert into items values ('just now')");
	const added = await box.basepad(main, "worktree", "add");
	expect(added.stderr).toBe("");
	expect(added.code).toBe(0);
	const tree = join(box.root, "t16busy.worktrees/worktree-1");
	expect(await sql(tree, "select string_agg(name, ',' order by name) from items")).toBe(
		"first,just now",
	);
	// A pool's next connection is a new one; it must be let in.
	expect(await sql(main, "select count(*) from items")).toBe("2");
}, 120_000);

test("worktree add says which route it copied by: a file clone on Postgres 18 where the server offers it", async () => {
	const offered = (
		await sql(main, "select enumvals::text from pg_settings where name = 'file_copy_method'")
	).includes("clone");
	const added = await box.basepad(main, "worktree", "add");
	expect(added.code).toBe(0);
	expect(added.stdout).toMatch(
		offered
			? /Copied main's `db` by file clone in [\d.]+ s\./
			: /Copied main's `db` by template copy in [\d.]+ s\./,
	);
}, 120_000);

test("on Postgres 17, which cannot clone, the copy is a template copy", async () => {
	const old = await project("t16old", 17);
	await sql(old, "create table items (name text); insert into items values ('old')");
	clients.push(await holdOpen(old));
	const added = await box.basepad(old, "worktree", "add");
	expect(added.stderr).toBe("");
	expect(added.stdout).toMatch(/Copied main's `db` by template copy in [\d.]+ s\./);
	expect(await sql(join(box.root, "t16old.worktrees/worktree-1"), "select name from items")).toBe(
		"old",
	);
}, 300_000);

test("a database left closed by an interrupted copy is opened again by the next up", async () => {
	const db = new URL(await url(main));
	const name = db.pathname.slice(1);
	db.pathname = "/postgres";
	const close = await box.psql([db.href], `alter database ${name} allow_connections false`);
	expect(close.stderr).toBe("");
	expect((await box.psql([await url(main)], "select 1")).code).not.toBe(0);
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect(await sql(main, "select count(*) from items")).toBe("2");
}, 120_000);

// The budget is provisional: a human sets it from the times measured on a Mac.
const MACOS_BUDGET_MS = 3_000;

test.runIf(process.platform === "darwin")(
	`on macOS, worktree add copies a database of about 1 GB within ${MACOS_BUDGET_MS / 1000} s`,
	async () => {
		const big = await project("t16big", 18);
		const init = await box.run("mise", [
			"exec",
			"postgres@18",
			"--",
			"pgbench",
			"-i",
			"-s",
			"70",
			"-q",
			await url(big),
		]);
		expect(init.code).toBe(0);
		clients.push(await holdOpen(big));
		const start = Date.now();
		const added = await box.basepad(big, "worktree", "add");
		const took = Date.now() - start;
		expect(added.code).toBe(0);
		expect(added.stdout).toContain("by file clone");
		expect(took).toBeLessThan(MACOS_BUDGET_MS);
	},
	600_000,
);
