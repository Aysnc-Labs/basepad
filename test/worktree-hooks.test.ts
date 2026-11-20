import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const web = `web: { run: ${JSON.stringify(`touch started && exec '${process.execPath}' '${echo}'`)} }`;
const note =
	'echo "$BASEPAD_EVENT $BASEPAD_ENVIRONMENT $(printenv WEB_URL || echo no-keys) $(test -e .env.local && echo files || echo no-files) $(test -e started && echo started || echo waiting)" >> marker';
const removal =
	'echo "$BASEPAD_EVENT $BASEPAD_ENVIRONMENT $BASEPAD_WORKTREE $(test -d "$BASEPAD_WORKTREE" && echo present || echo gone) $(printenv WEB_URL || echo no-keys)" >> removed';
const config = (hooks: Record<string, string | readonly string[]>) =>
	configFile(`{
	name: "t62trees",
	apps: { ${web} },
	env: ({ web }) => ({ ".env.local": { WEB_URL: web.url } }),
	hooks: ${JSON.stringify(hooks)},
}`);
const hooks = {
	beforeCreate: note,
	afterCreate: note,
	afterUp: note,
	beforeRemove: removal,
	afterRemove: removal,
};

let box: Sandbox;
let main: string;
let added: Result;
let tree: string;

const git = (cwd: string, ...args: string[]) =>
	promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
const read = async (file: string) => {
	const text = await readFile(file, "utf8").catch(() => "");
	await rm(file, { force: true });
	return text;
};
const url = (suffix: string) =>
	new RegExp(`https://web\\.${suffix}\\.t62trees\\.localhost(:\\d+)?`).source;

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t62trees", {
		"basepad.config.ts": config(hooks),
		".gitignore": "node_modules\n.env.local\nmarker\nremoved\nstarted\nbasepad.config.local.ts\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	for (const [branch, failing] of [
		["before-fails", { beforeCreate: ["echo nope; exit 3", note] }],
		["after-fails", { afterCreate: [note, "exit 4", note] }],
	] as const) {
		await git(main, "checkout", "--quiet", "-b", branch);
		await writeFile(join(main, "basepad.config.ts"), config({ ...hooks, ...failing }));
		await git(main, "commit", "--quiet", "-am", branch);
		await git(main, "checkout", "--quiet", "main");
	}
	added = await box.basepad(main, "worktree", "add", "--start", "--json");
	tree = join(box.root, "t62trees.worktrees/worktree-1");
}, 300_000);
afterAll(() => box?.dispose());

test("`worktree add` runs beforeCreate before the env files exist, and afterCreate with them before `--start`'s apps", async () => {
	expect(added.code).toBe(0);
	expect(await read(join(tree, "marker"))).toMatch(
		new RegExp(
			`^beforeCreate worktree-1 no-keys no-files waiting\nafterCreate worktree-1 ${url("worktree-1")} files waiting\n$`,
		),
	);
	expect(existsSync(join(main, "marker"))).toBe(false);
});

test("under `--json`, hook output goes to stderr and stdout holds only the JSON", () => {
	expect(JSON.parse(added.stdout)).toEqual({ name: "worktree-1", path: tree });
	expect(added.stderr).toContain("Running afterCreate `echo");
});

test("`up` in a git worktree made by hand runs the Create hooks once, before its Up hooks; main's `up` never does", async () => {
	const hand = join(box.root, "hand");
	await git(main, "worktree", "add", "--quiet", hand);
	expect((await box.basepad(hand, "up")).code).toBe(0);
	expect(await read(join(hand, "marker"))).toMatch(
		new RegExp(
			`^beforeCreate hand no-keys no-files waiting\nafterCreate hand ${url("hand")} files waiting\nafterUp hand ${url("hand")} files started\n$`,
		),
	);
	expect((await box.basepad(hand, "up")).code).toBe(0);
	expect(await read(join(hand, "marker"))).toMatch(/^afterUp hand \S+ files started\n$/);
	expect((await box.basepad(main, "up")).code).toBe(0);
	expect(await read(join(main, "marker"))).toMatch(/^afterUp main \S+ files started\n$/);
});

test("a failed beforeCreate keeps the worktree, before its env files, and exits 1 with where it is", async () => {
	const out = await box.basepad(main, "worktree", "add", "--branch", "before-fails");
	const kept = join(box.root, "t62trees.worktrees/worktree-2");
	expect(out.code).toBe(1);
	expect(out.stdout).toContain("  nope");
	expect(out.stderr).toContain("beforeCreate `echo nope; exit 3` failed (exit 3).");
	expect(out.stderr).toContain(
		`Worktree worktree-2 is checked out at ${kept}; once that is fixed, run \`basepad up\` there.`,
	);
	expect(existsSync(join(kept, ".env.local"))).toBe(false);
	expect(existsSync(join(kept, "marker"))).toBe(false);
});

test("a failed afterCreate keeps the ready worktree, stops its other commands, and exits 1 with where it is", async () => {
	const out = await box.basepad(main, "worktree", "add", "--branch", "after-fails", "--start");
	const kept = join(box.root, "t62trees.worktrees/worktree-3");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("afterCreate `exit 4` failed (exit 4).");
	expect(out.stderr).toContain(`Worktree worktree-3 is checked out at ${kept}; once that is fixed`);
	expect(await read(join(kept, "marker"))).toMatch(
		/^beforeCreate worktree-3 no-keys no-files waiting\nafterCreate worktree-3 \S+ files waiting\n$/,
	);
	expect(existsSync(join(kept, "started"))).toBe(false);
	expect((await box.basepad(kept, "up")).code).toBe(0);
	expect(await read(join(kept, "marker"))).toMatch(/^afterUp worktree-3 /);
});

test("`worktree rm` runs main's Remove hooks from main's folder, with the worktree's suffix, path and env file keys", async () => {
	await writeFile(
		join(tree, "basepad.config.ts"),
		config({ beforeRemove: "echo wrong >> removed" }),
	);
	const out = await box.basepad(main, "worktree", "rm", "worktree-1", "--force");
	expect(out.code).toBe(0);
	expect(await read(join(main, "removed"))).toMatch(
		new RegExp(
			`^beforeRemove worktree-1 ${tree} present ${url("worktree-1")}\nafterRemove worktree-1 ${tree} gone no-keys\n$`,
		),
	);
});

test("`prune` runs main's Remove hooks for a worktree whose folder is gone, and a failed one only warns", async () => {
	const hand = join(box.root, "hand");
	await box.basepad(hand, "down");
	await rm(hand, { recursive: true, force: true });
	await writeFile(
		join(main, "basepad.config.local.ts"),
		`export default (config) => ({ ...config, hooks: { ...config.hooks, afterRemove: ["exit 7", ${JSON.stringify(removal)}] } });\n`,
	);
	const out = await box.basepad(main, "prune", "--yes");
	expect(out.code).toBe(0);
	expect(out.stderr).toContain("afterRemove `exit 7` failed (exit 7). Going on.");
	expect(await read(join(main, "removed"))).toBe(`beforeRemove hand ${hand} gone no-keys\n`);
	await rm(join(main, "basepad.config.local.ts"));
});

test("`worktree rm --claude` prints hook output to stderr only", async () => {
	const kept = join(box.root, "t62trees.worktrees/worktree-3");
	await box.basepad(kept, "down");
	const out = await box.basepadWith(
		{ input: JSON.stringify({ worktree_path: kept, cwd: main }) },
		main,
		"worktree",
		"rm",
		"--claude",
	);
	expect(out.code).toBe(0);
	expect(out.stdout).toBe("");
	expect(out.stderr).toContain("Running beforeRemove `echo");
	await read(join(main, "removed"));
	await box.basepad(main, "down");
});
