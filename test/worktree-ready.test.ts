import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

/** A worktree ready to use: cloned paths, setup commands, `--branch`, and starting on first request. */

const echo = join(import.meta.dirname, "apps/echo.mjs");
const web = `web: { run: ${JSON.stringify(`exec '${process.execPath}' '${echo}'`)} }`;
const config = (setup: string[]) =>
	configFile(`{
	name: "t17shop",
	services: { db: postgres() },
	apps: { ${web} },
	env: ({ db }) => ({ ".env.local": { DATABASE_URL: db.url } }),
	worktrees: { clone: ["deps", "gone"], setup: ${JSON.stringify(setup)} },
}`);

let box: Sandbox;
let main: string;
let added: Result;
/** The worktree the plain `worktree add` made. */
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
const url = (host: string) => `https://${host}:${box.proxyPort}`;

beforeAll(async () => {
	box = await sandbox();
	const files: Record<string, string> = {
		"basepad.config.ts": config(["grep DATABASE_URL .env.local > marker", "echo second >> marker"]),
		".gitignore": "node_modules\n.env.local\ndeps\nmarker\n",
		"deps/a/b/c/nested.txt": "deep",
	};
	for (let i = 0; i < 500; i++) files[`deps/a/file-${i}.txt`] = `file ${i}`;
	main = await box.project("t17shop", files);
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	// A branch whose config's second setup command fails.
	await git(main, "checkout", "--quiet", "-b", "broken");
	await writeFile(
		join(main, "basepad.config.ts"),
		config(["echo first > marker", "echo boom; echo bad >&2; exit 3", "echo never > never"]),
	);
	await git(main, "commit", "--quiet", "-am", "broken setup");
	await git(main, "checkout", "--quiet", "main");
	added = await box.basepad(main, "worktree", "add");
	tree = join(box.root, "t17shop.worktrees/worktree-1");
}, 300_000);
afterAll(() => box?.dispose());

test("each path in `worktrees.clone` is copied from main, and a missing one is skipped with a note", async () => {
	expect(added.stderr).toBe("");
	expect(added.code).toBe(0);
	expect(await readFile(join(tree, "deps/a/b/c/nested.txt"), "utf8")).toBe("deep");
	expect(await readFile(join(tree, "deps/a/file-499.txt"), "utf8")).toBe("file 499");
	expect(added.stdout).toContain("Skipped `gone` from `worktrees.clone`: main has none.");
});

test("a write under a cloned path in the worktree leaves main's files alone", async () => {
	await writeFile(join(tree, "deps/a/file-0.txt"), "changed in the worktree");
	await mkdir(join(tree, "deps/new"));
	expect(await readFile(join(main, "deps/a/file-0.txt"), "utf8")).toBe("file 0");
	expect(existsSync(join(main, "deps/new"))).toBe(false);
});

test("`worktrees.setup` runs in order in the worktree, after its env files are written", async () => {
	const marker = await readFile(join(tree, "marker"), "utf8");
	expect(marker).toMatch(/^DATABASE_URL=\S+\/t17shop_db_worktree_1\nsecond\n$/);
});

test("worktree add starts no app, and the first request starts it even with main's database server stopped", async () => {
	expect(added.stdout).toMatch(/web +https:\/\/web\.worktree-1\.t17shop\.localhost:\d+ +stopped/);
	// `down` in main stops its database server, which the worktree's database lives on.
	expect((await box.basepad(main, "down")).code).toBe(0);
	expect((await box.basepad(main, "status")).stdout).toMatch(/db +\S+ +stopped/);
	expect((await box.get<{ cwd: string }>(url("web.worktree-1.t17shop.localhost"))).cwd).toBe(tree);
	expect((await box.basepad(tree, "status")).stdout).toMatch(
		/web +\S+ +running[\s\S]*db +\S+ +running/,
	);
	// Main's app stays stopped after `down`, whatever opens its domain.
	await expect(box.get(url("web.t17shop.localhost"))).rejects.toThrow();
});

test("--branch checks out an existing branch; a failing setup command is reported with its output, stops the rest, and keeps the worktree", async () => {
	const out = await box.basepad(main, "worktree", "add", "--branch", "broken");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("`echo boom; echo bad >&2; exit 3` failed (exit 3)");
	expect(out.stderr).toContain("boom");
	expect(out.stderr).toContain("bad");
	const broken = join(box.root, "t17shop.worktrees/worktree-2");
	expect(out.stderr).toContain(`Worktree worktree-2 is checked out at ${broken}`);
	expect(await git(broken, "branch", "--show-current")).toBe("broken");
	expect(await readFile(join(broken, "marker"), "utf8")).toBe("first\n");
	expect(existsSync(join(broken, "never"))).toBe(false);
});

test("--branch makes a branch that does not exist, from main's HEAD, and --start starts the worktree's apps", async () => {
	const out = await box.basepad(main, "worktree", "add", "--branch", "fresh-idea", "--start");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	const fresh = join(box.root, "t17shop.worktrees/worktree-3");
	expect(out.stdout).toContain(`Made worktree worktree-3 at ${fresh}, on branch fresh-idea.`);
	expect(await git(fresh, "branch", "--show-current")).toBe("fresh-idea");
	expect(await git(fresh, "rev-parse", "HEAD")).toBe(await git(main, "rev-parse", "main"));
	expect(out.stdout).toMatch(/web +https:\/\/web\.worktree-3\.t17shop\.localhost:\d+ +running/);
	expect((await box.get<{ cwd: string }>(url("web.worktree-3.t17shop.localhost"))).cwd).toBe(fresh);
});
