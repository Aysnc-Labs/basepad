import { type ChildProcess, execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

/** `db save`, `load`, `snapshots` and `rm`: snapshots of the environment's own database. */

let box: Sandbox;
let main: string;
const clients: ChildProcess[] = [];

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

/** A main checkout under git with `services`, up; `env` writes `<KEY>_URL` for each. */
async function project(name: string, services: Record<string, string>): Promise<string> {
	const keys = Object.keys(services);
	const dir = await box.project(name, {
		"basepad.config.ts": configFile(`{
	name: "${name}",
	services: { ${keys.map((key) => `${key}: ${services[key]}`).join(", ")} },
	env: ({ ${keys.join(", ")} }) => ({ ".env.local": { ${keys
		.map((key) => `${key.toUpperCase()}_URL: ${key}.url`)
		.join(", ")} } }),
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

const url = async (dir: string, key = "db") =>
	(await readEnv(dir, ".env.local"))[`${key.toUpperCase()}_URL`] as string;

async function sql(dir: string, query: string, key = "db"): Promise<string> {
	const out = await box.psql([await url(dir, key)], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

const rows = (dir: string, key = "db") =>
	sql(dir, "select coalesce(string_agg(name, ',' order by name), '') from items", key);

/** `basepad` in `dir`, expected to succeed; its output. */
async function ok(dir: string, ...args: string[]): Promise<string> {
	const result = await box.basepad(dir, ...args);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	return result.stdout;
}

/** A client that connects to `dir`'s database and stays connected, as an app's pool does. */
async function holdOpen(dir: string): Promise<ChildProcess> {
	const db = await url(dir);
	const client = spawn("mise", ["exec", "postgres@18", "--", "psql", db, "-tAX"], {
		cwd: box.root,
		env: box.env,
		stdio: ["pipe", "ignore", "ignore"],
	});
	clients.push(client);
	for (let i = 0; i < 100; i++) {
		if ((await sessions(dir)) !== "0") return client;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("The client never connected.");
}

/** How many other sessions hold `dir`'s database. */
async function sessions(dir: string): Promise<string> {
	const db = await url(dir);
	const name = new URL(db).pathname.slice(1);
	return sql(
		dir,
		`select count(*) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
	);
}

beforeAll(async () => {
	box = await sandbox();
	main = await project("t26snap", { db: "postgres()" });
	await sql(main, "create table items (name text); insert into items values ('saved')");
}, 300_000);
afterAll(async () => {
	for (const client of clients) client.kill();
	await box?.dispose();
});

test("after save, a change and load, the database holds the saved rows, with a default label", async () => {
	await ok(main, "db", "save");
	await sql(main, "insert into items values ('after')");
	expect(await rows(main)).toBe("after,saved");
	await ok(main, "db", "load");
	expect(await rows(main)).toBe("saved");
}, 120_000);

test("save and load work while a client holds the database open, and a new connection gets in", async () => {
	await holdOpen(main);
	await ok(main, "db", "save", "busy");
	expect(await sessions(main)).toBe("0");
	await sql(main, "insert into items values ('busy')");
	await holdOpen(main);
	await ok(main, "db", "load", "busy");
	expect(await sessions(main)).toBe("0");
	// A pool's next connection is a new one, to the loaded database.
	expect(await rows(main)).toBe("saved");
}, 120_000);

test("snapshots lists each with its label, database and size; rm deletes one", async () => {
	await ok(main, "db", "save", "first");
	await ok(main, "db", "save", "second");
	const listed = await ok(main, "db", "snapshots");
	expect(listed).toMatch(/LABEL\s+SERVICE\s+DATABASE\s+SIZE/);
	expect(listed).toMatch(/first\s+db\s+t26snap_db\s+[\d.]+ [kM]?B/);
	expect(listed).toMatch(/second\s+db\s+t26snap_db\s+[\d.]+ [kM]?B/);
	expect(await ok(main, "db", "rm", "first")).toContain("Deleted snapshot first");
	const after = await ok(main, "db", "snapshots");
	expect(after).not.toMatch(/^first /m);
	expect(after).toMatch(/^second /m);
}, 120_000);

test("load or rm of a label with no snapshot fails, naming the ones there are, and changes nothing", async () => {
	const before = await rows(main);
	for (const verb of ["load", "rm"]) {
		const result = await box.basepad(main, "db", verb, "nope");
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/`db` has no snapshot `nope`\. Its snapshots: .*`second`/);
	}
	expect(await rows(main)).toBe(before);
}, 120_000);

test("a label that would make a name too long, or is no label, is rejected before anything is saved", async () => {
	const long = "x".repeat(60);
	const tooLong = await box.basepad(main, "db", "save", long);
	expect(tooLong.code).toBe(1);
	expect(tooLong.stderr).toMatch(/is 71 bytes; Postgres allows 63, which leaves 52 characters/);
	const bad = await box.basepad(main, "db", "save", "Before_Migration");
	expect(bad.code).toBe(1);
	expect(bad.stderr).toContain(
		"A snapshot label must be lowercase letters, digits and inner hyphens",
	);
	expect(await ok(main, "db", "snapshots")).not.toContain("xxxx");
}, 120_000);

/** The databases on `dir`'s `db` server whose name has `@`: every environment's snapshots. */
const snapshotDatabases = async (dir: string) =>
	(
		await sql(
			dir,
			"select string_agg(datname, ',' order by datname) from pg_database where datname like '%@%'",
		)
	).split(",");

test("with several databases, the service is required and the choices are listed", async () => {
	const two = await project("t26two", {
		db: "postgres()",
		ref: 'postgres({ worktree: "shared" })',
	});
	await sql(two, "create table items (name text); insert into items values ('db')");
	await sql(two, "create table items (name text); insert into items values ('ref')", "ref");
	const bare = await box.basepad(two, "db", "save");
	expect(bare.code).toBe(1);
	expect(bare.stderr).toContain(
		"has several databases: `db`, `ref`. Name one with `--service <key>`.",
	);
	const wrong = await box.basepad(two, "db", "save", "--service", "nope");
	expect(wrong.code).toBe(1);
	expect(wrong.stderr).toContain("has no database service `nope`. Its databases: `db`, `ref`.");
	await ok(two, "db", "save", "-s", "ref");
	await sql(two, "delete from items", "ref");
	await sql(two, "delete from items");
	await ok(two, "db", "load", "--service", "ref");
	expect(await rows(two, "ref")).toBe("ref");
	// Only the named service's database is replaced.
	expect(await rows(two)).toBe("");
	const listed = await ok(two, "db", "snapshots");
	expect(listed).toMatch(/default\s+ref\s+t26two_ref\s/);

	await ok(two, "worktree", "add");
	const tree = join(box.root, "t26two.worktrees/worktree-1");
	const shared = await box.basepad(tree, "db", "load", "-s", "ref");
	expect(shared.code).toBe(1);
	expect(shared.stderr).toContain("`ref` is shared with main in worktrees");
	expect(await rows(two, "ref")).toBe("ref");
}, 300_000);

test("inside a worktree the commands act on its database and snapshots, and leave main's unchanged", async () => {
	await ok(main, "db", "save", "same");
	const mainRows = await rows(main);
	await ok(main, "worktree", "add");
	const tree = join(box.root, "t26snap.worktrees/worktree-1");
	await sql(tree, "insert into items values ('tree')");
	await ok(tree, "db", "save", "same");
	await ok(tree, "db", "save", "tree-only");
	await sql(tree, "delete from items");
	await ok(tree, "db", "load", "same");
	expect(await rows(tree)).toBe(`${mainRows},tree`.split(",").sort().join(","));
	expect(await rows(main)).toBe(mainRows);

	// Each lists its own, and main cannot reach the worktree's.
	expect(await ok(tree, "db", "snapshots")).toMatch(/same\s+db\s+t26snap_db_worktree_1\s/);
	expect(await ok(tree, "db", "snapshots")).not.toMatch(/\st26snap_db\s/);
	expect(await ok(main, "db", "snapshots")).not.toContain("tree-only");
	const fromMain = await box.basepad(main, "db", "load", "tree-only");
	expect(fromMain.code).toBe(1);
	expect(await rows(main)).toBe(mainRows);

	// Main's own snapshot of the same label is still main's rows.
	await ok(main, "db", "load", "same");
	expect(await rows(main)).toBe(mainRows);
	await ok(tree, "db", "rm", "same");
	expect(await snapshotDatabases(main)).toContain("t26snap_db@same");
}, 300_000);

test("worktree rm and prune remove a worktree's snapshots, and never main's", async () => {
	const mainSnapshots = (await snapshotDatabases(main)).filter((name) =>
		name.startsWith("t26snap_db@"),
	);
	expect(mainSnapshots.length).toBeGreaterThan(0);

	await ok(main, "worktree", "rm", "worktree-1", "--force");
	expect((await snapshotDatabases(main)).filter((name) => name.includes("worktree_1"))).toEqual([]);

	const added = JSON.parse((await box.basepad(main, "worktree", "add", "--json")).stdout) as {
		name: string;
		path: string;
	};
	const tree = added.path;
	const left = `t26snap_db_${added.name.replaceAll("-", "_")}@left`;
	await ok(tree, "db", "save", "left");
	expect(await snapshotDatabases(main)).toContain(left);
	await rm(tree, { recursive: true, force: true });
	const status = await ok(main, "status");
	expect(status).toContain(left);
	await ok(main, "prune", "--yes");
	expect(await snapshotDatabases(main)).not.toContain(left);

	expect((await snapshotDatabases(main)).filter((name) => name.startsWith("t26snap_db@"))).toEqual(
		mainSnapshots,
	);
}, 300_000);
