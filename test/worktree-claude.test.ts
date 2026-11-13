import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const node = (script: string) => `exec '${process.execPath}' '${script}'`;

let box: Sandbox;
let main: string;
const url = (host: string) => `https://${host}:${box.proxyPort}`;

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

async function sql(at: string, query: string): Promise<string> {
	const out = await box.psql([at], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

const databases = async () =>
	(
		await sql(
			(
				await readEnv(main, ".env.local")
			).DATABASE_URL as string,
			"select datname from pg_database order by 1",
		)
	).split("\n");

/** What Claude Code sends a command hook on standard input, from its hooks reference. */
const hookInput = (event: string, fields: Record<string, string>) =>
	JSON.stringify({
		session_id: "abc123",
		transcript_path: "/tmp/transcripts/00893aaf.jsonl",
		cwd: main,
		permission_mode: "default",
		hook_event_name: event,
		...fields,
	});

/** Claude Code runs a hook in the session's folder; the input's `cwd` says which it is. */
const create = (fields: Record<string, string>, ...flags: string[]) =>
	box.basepadWith(
		{ input: hookInput("WorktreeCreate", fields) },
		box.root,
		"worktree",
		"add",
		"--claude",
		...flags,
	);
const remove = (path: string) =>
	box.basepadWith(
		{ input: hookInput("WorktreeRemove", { worktree_path: path }) },
		box.root,
		"worktree",
		"rm",
		"--claude",
	);

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t19shop", {
		"basepad.config.ts": configFile(`{
	name: "t19shop",
	services: { db: postgres() },
	apps: { web: { run: ${JSON.stringify(node(echo))} } },
	env: ({ db, web }) => ({ ".env.local": { DATABASE_URL: db.url, WEB_URL: web.url } }),
}`),
		".gitignore": "node_modules\n.env.local\n",
		".env.local": "SECRET=hunter2\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	expect((await box.basepad(main, "up")).stderr).toBe("");
	await sql(
		(await readEnv(main, ".env.local")).DATABASE_URL as string,
		"create table items (name text); insert into items values ('from main')",
	);
}, 300_000);
afterAll(() => box?.dispose());

test("up in a git worktree made by hand makes it a worktree whose suffix is its folder name", async () => {
	const hand = join(box.root, "hand");
	await git(main, "worktree", "add", "--quiet", "-b", "by-hand", hand);
	const out = await box.basepad(hand, "up");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(out.stdout).toContain(`web  ${url("web.hand.t19shop.localhost")}  running`);
	const env = await readEnv(hand, ".env.local");
	expect(env.SECRET).toBe("hunter2");
	expect(env.DATABASE_URL).toMatch(/\/t19shop_db_hand$/);
	expect(await sql(env.DATABASE_URL as string, "select name from items")).toBe("from main");
	expect((await box.get<{ cwd: string }>(url("web.hand.t19shop.localhost"))).cwd).toBe(hand);
});

test("a hand-made worktree whose folder name is no valid name is refused with the reason", async () => {
	const bad = join(box.root, "Hand_Made");
	await git(main, "worktree", "add", "--quiet", "-b", "bad-name", bad);
	const out = await box.basepad(bad, "up");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("`Hand_Made`");
	expect(out.stderr).toContain("lowercase DNS label");
	expect(out.stderr).toContain("git worktree move");
	expect(await databases()).not.toContain("t19shop_db_hand_made");
});

let made: string;

test("worktree add --claude makes a worktree on the hook's name as its branch, printing only its path", async () => {
	const out = await create({ name: "bold-oak-a3f2" });
	expect(out.code).toBe(0);
	made = join(box.root, "t19shop.worktrees/worktree-1");
	expect(out.stdout).toBe(`${made}\n`);
	expect(out.stderr).toContain("Made worktree worktree-1");
	expect(await git(made, "branch", "--show-current")).toBe("bold-oak-a3f2");
	const env = await readEnv(made, ".env.local");
	expect(env.WEB_URL).toBe(url("web.worktree-1.t19shop.localhost"));
	expect(await sql(env.DATABASE_URL as string, "select name from items")).toBe("from main");
});

test("worktree add --claude fails with nothing on stdout when the input has no name", async () => {
	const out = await create({});
	expect(out.code).toBe(1);
	expect(out.stdout).toBe("");
	expect(out.stderr).toContain("WorktreeCreate");
	expect(out.stderr).toContain("name");
});

test("worktree add --claude refuses --branch, which would disagree with the hook's name", async () => {
	const out = await create({ name: "x" }, "--branch", "y");
	expect(out.code).toBe(1);
	expect(out.stdout).toBe("");
	expect(out.stderr).toContain("--branch");
});

test("worktree rm --claude removes the worktree at worktree_path, changes and all, keeping its branch", async () => {
	await writeFile(join(made, "scratch.txt"), "Claude Code asked before discarding this\n");
	const out = await remove(made);
	expect(out.stderr).toContain("Removed worktree worktree-1");
	expect(out.code).toBe(0);
	expect(out.stdout).toBe("");
	expect(existsSync(made)).toBe(false);
	expect(await databases()).not.toContain("t19shop_db_worktree_1");
	expect(await git(main, "branch", "--list", "bold-oak-a3f2")).toContain("bold-oak-a3f2");
});

test("worktree rm --claude, run inside a long-named worktree whose config is broken, removes it", async () => {
	const long = join(box.root, "l".repeat(64));
	await git(main, "worktree", "add", "--quiet", "-b", "long", long);
	await writeFile(join(long, "basepad.config.ts"), "this is not a config {");
	const out = await box.basepadWith(
		{ input: hookInput("WorktreeRemove", { worktree_path: long, cwd: long }) },
		long,
		"worktree",
		"rm",
		"--claude",
	);
	expect(out.stderr).toContain("Removed worktree");
	expect(out.code).toBe(0);
	expect(existsSync(long)).toBe(false);
});

test("worktree rm --claude fails for a path that is no worktree of main", async () => {
	const out = await remove(join(main, "elsewhere"));
	expect(out.code).toBe(1);
	expect(out.stderr).toContain(join(main, "elsewhere"));
});

test("worktree rm without --claude still needs a worktree", async () => {
	const out = await box.basepad(main, "worktree", "rm");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("Usage: basepad worktree rm <worktree>");
});
