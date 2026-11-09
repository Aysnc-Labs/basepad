import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockOf, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
let main: string;

beforeAll(async () => {
	box = await sandbox();
	main = await box.repo("store", {
		"basepad.toml": "[services.postgres]\n",
		".gitignore": [".env.local", ".config/mise/conf.d/", "secret.txt", ""].join("\n"),
		".worktreeinclude": "secret.txt\n",
		// A hook that talks on stdout, as install scripts do: none of it may reach basepad's stdout.
		"mise.toml": '[tasks."basepad:post-create"]\nrun = "echo installing dependencies"\n',
	});
	expect((await box.basepad(main, "up")).code).toBe(0);
	await writeFile(join(main, "secret.txt"), "from main\n");
});
afterAll(async () => {
	await box?.dispose();
});

/** What Claude Code sends a command hook on stdin, from its hooks reference. */
const hookInput = (event: string, fields: Record<string, string>) =>
	JSON.stringify({
		session_id: "abc123",
		transcript_path: "/tmp/transcripts/00893aaf.jsonl",
		cwd: main,
		hook_event_name: event,
		...fields,
	});

/** Claude Code runs hooks in the session's current directory, which needn't be the repo. */
const create = (name: string) =>
	box.basepadWith(
		{ input: hookInput("WorktreeCreate", { name }) },
		box.root,
		"worktree",
		"add",
		"--claude",
	);
const remove = (worktreePath: string, cwd = worktreePath) =>
	box.basepadWith(
		{ input: hookInput("WorktreeRemove", { worktree_path: worktreePath }) },
		cwd,
		"worktree",
		"remove",
		"--claude",
	);
const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);
const hasBranch = async (name: string) =>
	(await box.git(main, "show-ref", "--verify", "--quiet", `refs/heads/${name}`)).code === 0;

describe("worktree add --claude, as Claude Code's WorktreeCreate hook", () => {
	let path: string;

	test("prints only the worktree's absolute path on stdout, and everything else on stderr", async () => {
		const out = await create("bold-oak-a3f2");
		expect(out.stderr).toContain("installing dependencies");
		expect(out.code).toBe(0);
		path = join(dirname(main), `${basename(main)}-bold-oak-a3f2`);
		expect(out.stdout).toBe(`${path}\n`);
		expect(isAbsolute(path)).toBe(true);
		expect(out.stderr).toContain("Worktree bold-oak-a3f2 is ready");
	});

	test("the worktree is ready: .worktreeinclude's files, its own database, its env block", async () => {
		expect(await readFile(join(path, "secret.txt"), "utf8")).toBe("from main\n");
		const vars = blockOf(await readFile(join(path, ".env.local"), "utf8"));
		expect(vars.DATABASE_URL).toMatch(/\/store_bold_oak_a3f2$/);
		expect((await box.psql(vars.DATABASE_URL as string, "select 1")).stdout.trim()).toBe("1");
	});

	test("fails with nothing on stdout when the input has no name", async () => {
		const out = await box.basepadWith(
			{ input: hookInput("WorktreeCreate", {}) },
			main,
			"worktree",
			"add",
			"--claude",
		);
		expect(out.code).not.toBe(0);
		expect(out.stdout).toBe("");
		expect(out.stderr).toContain("name");
	});

	test("refuses a name on the command line, which would disagree with the hook's", async () => {
		const out = await box.basepadWith({ input: "{}" }, main, "worktree", "add", "x", "--claude");
		expect(out.code).not.toBe(0);
		expect(out.stdout).toBe("");
	});
});

describe("worktree remove --claude, as Claude Code's WorktreeRemove hook", () => {
	test("removes the worktree at worktree_path, uncommitted work and all, and deletes its branch", async () => {
		const path = (await create("quiet-elm")).stdout.trim();
		const url = blockOf(await readFile(join(path, ".env.local"), "utf8")).DATABASE_URL as string;
		await writeFile(join(path, "scratch.txt"), "Claude already asked before discarding this\n");

		const out = await remove(path);
		expect(out.stderr).toContain("quiet-elm");
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("");
		expect(await exists(path)).toBe(false);
		expect(await hasBranch("quiet-elm")).toBe(false);
		const left = await box.psql(
			url.replace(/\/[^/]+$/, "/postgres"),
			"select count(*) from pg_database where datname = 'store_quiet_elm'",
		);
		expect(left.stdout.trim()).toBe("0");
		expect((await box.basepad(main, "worktree", "ls")).stdout).not.toContain("quiet-elm");
	});

	test("keeps a branch that has commits main doesn't, and says so", async () => {
		const path = (await create("brave-fir")).stdout.trim();
		await writeFile(join(path, "feature.txt"), "work\n");
		await box.git(path, "add", "feature.txt");
		expect((await box.git(path, "commit", "--quiet", "-m", "Unmerged work")).code).toBe(0);

		const out = await remove(path, main);
		expect(out.code).toBe(0);
		expect(await exists(path)).toBe(false);
		expect(await hasBranch("brave-fir")).toBe(true);
		expect(out.stderr).toMatch(/[Kk]ept branch brave-fir/);
	});

	test("fails for a path basepad didn't make", async () => {
		const out = await remove(join(box.root, "elsewhere"), main);
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain("elsewhere");
	});
});
