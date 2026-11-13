import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const node = (script: string) => `exec '${process.execPath}' '${script}'`;

const config = (apps: string) =>
	configFile(`{
	name: "t15shop",
	services: {
		db: postgres(),
		blank: postgres({ worktree: "empty" }),
		ref: postgres({ worktree: "shared" }),
	},
	apps: { ${apps} },
	env: ({ db, blank, ref, web }) => ({
		".env.local": { DATABASE_URL: db.url, BLANK_URL: blank.url, REF_URL: ref.url, WEB_URL: web.url },
	}),
}`);
const web = `web: { run: ${JSON.stringify(node(echo))} }`;

let box: Sandbox;
let main: string;
let added: Result;
/** The worktree `worktree add` made. */
let tree: string;

const git = async (cwd: string, ...args: string[]) => {
	const { stdout } = await promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	return stdout.trim();
};

async function sql(url: string, query: string): Promise<string> {
	const out = await box.psql([url], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t15shop", {
		"basepad.config.ts": config(web),
		".gitignore": "node_modules\n.env.local\n",
		".env.local": "# mine\nSECRET=hunter2\nDATABASE_URL=stale\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	// One made by hand already, so `worktree add` takes the next number.
	await git(
		main,
		"worktree",
		"add",
		"--quiet",
		"-b",
		"worktree-1",
		"../t15shop.worktrees/worktree-1",
	);
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	for (const key of ["DATABASE_URL", "BLANK_URL", "REF_URL"]) {
		const url = (await readEnv(main, ".env.local"))[key] as string;
		await sql(url, "create table items (name text); insert into items values ('from main')");
	}
	added = await box.basepad(main, "worktree", "add");
	tree = join(box.root, "t15shop.worktrees/worktree-2");
}, 300_000);
afterAll(() => box?.dispose());

const env = (dir: string) => readEnv(dir, ".env.local");
const url = (host: string) => `https://${host}:${box.proxyPort}`;

test("worktree add names the worktree from git, checks it out beside the project on its own branch, and prints its path", async () => {
	expect(added.stderr).toBe("");
	expect(added.code).toBe(0);
	expect(added.stdout).toContain(`Made worktree worktree-2 at ${tree}, on branch worktree-2.`);
	expect(await git(tree, "branch", "--show-current")).toBe("worktree-2");
	expect(added.stdout).toMatch(/web +https:\/\/web\.worktree-2\.t15shop\.localhost:\d+ +stopped/);
});

test("a copied database holds main's rows, under the worktree's name, stamped with its path", async () => {
	const { DATABASE_URL } = await env(tree);
	expect(DATABASE_URL).toMatch(/\/t15shop_db_worktree_2$/);
	expect(await sql(DATABASE_URL as string, "select name from items")).toBe("from main");
	expect(
		await sql(
			DATABASE_URL as string,
			"select shobj_description(oid, 'pg_database') from pg_database where datname = current_database()",
		),
	).toBe(tree);
});

test("the worktree's writes leave main's rows alone", async () => {
	await sql((await env(tree)).DATABASE_URL as string, "insert into items values ('from tree')");
	expect(await sql((await env(main)).DATABASE_URL as string, "select count(*) from items")).toBe(
		"1",
	);
});

test("an `empty` service gives an empty database, a `shared` one main's own", async () => {
	const { BLANK_URL, REF_URL } = await env(tree);
	expect(BLANK_URL).toMatch(/\/t15shop_blank_worktree_2$/);
	expect(
		await sql(BLANK_URL as string, "select count(*) from pg_tables where tablename = 'items'"),
	).toBe("0");
	expect(REF_URL).toBe((await env(main)).REF_URL);
});

test("env files start as main's, with basepad's keys set for the worktree", async () => {
	const text = await readFile(join(tree, ".env.local"), "utf8");
	const { DATABASE_URL } = await env(tree);
	expect(text.startsWith(`# mine\nSECRET=hunter2\nDATABASE_URL=${DATABASE_URL}\n`)).toBe(true);
	expect((await env(tree)).WEB_URL).toBe(url("web.worktree-2.t15shop.localhost"));
});

test("--json prints only the next worktree's name and path", async () => {
	const out = await box.basepad(main, "worktree", "add", "--json");
	expect(out.code).toBe(0);
	expect(JSON.parse(out.stdout)).toEqual({
		name: "worktree-3",
		path: join(box.root, "t15shop.worktrees/worktree-3"),
	});
});

test("up in the worktree serves its app at its own domain, while main's keeps answering", async () => {
	const out = await box.basepad(tree, "up");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(out.stdout).toContain(`web  ${url("web.worktree-2.t15shop.localhost")}  running`);
	expect((await box.get<{ cwd: string }>(url("web.worktree-2.t15shop.localhost"))).cwd).toBe(tree);
	expect((await box.get<{ cwd: string }>(url("web.t15shop.localhost"))).cwd).toBe(main);
	const status = await box.basepad(tree, "status");
	expect(status.stdout).toMatch(/db +postgresql:\/\/\S+\/t15shop_db_worktree_2 +running/);
});

test("the worktree applies the config in its own folder", async () => {
	await writeFile(
		join(tree, "basepad.config.ts"),
		config(`${web}, api: { run: ${JSON.stringify(node(echo))} }`),
	);
	const out = await box.basepad(tree, "up");
	expect(out.stderr).toBe("");
	expect(out.stdout).toContain(`api  ${url("api.worktree-2.t15shop.localhost")}  running`);
	expect((await box.get<{ cwd: string }>(url("api.worktree-2.t15shop.localhost"))).cwd).toBe(tree);
	await expect(box.get(url("api.t15shop.localhost"))).rejects.toThrow();
});

test("down in the worktree stops its apps and leaves main's running", async () => {
	expect((await box.basepad(tree, "down")).code).toBe(0);
	await expect(box.get(url("web.worktree-2.t15shop.localhost"))).rejects.toThrow();
	expect((await box.get<{ cwd: string }>(url("web.t15shop.localhost"))).cwd).toBe(main);
});

test("basepad keeps no list of worktrees", async () => {
	const home = join(box.root, "home");
	const files = (await readdir(home, { recursive: true })).filter(
		(path) => !path.startsWith("pitchfork") && !path.startsWith("services"),
	);
	// Only each environment's generated definitions, which the supervisor reads.
	expect(files.filter((path) => path.includes("worktree")).sort()).toEqual([
		"environments/t15shop.worktree-2.toml",
		"environments/t15shop.worktree-3.toml",
	]);
});

test("a prefix that would make too long a name fails before anything is made", async () => {
	const dir = await box.project("t15long", {
		"basepad.config.ts": configFile(
			`{ name: "t15long", worktrees: { prefix: "${"p".repeat(60)}" } }`,
		),
	});
	const out = await box.basepad(dir, "worktree", "add");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("leave too little room: the worktree suffix is 64 characters");
});
