import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const web = `web: { run: ${JSON.stringify(`touch started && exec '${process.execPath}' '${echo}'`)} }`;
const note = (what: string) =>
	`echo "${what} $BASEPAD_EVENT $BASEPAD_ENVIRONMENT $GREETING $(test -e started && echo started || echo waiting) $(read line; echo stdin=$?)" >> marker`;
const config = configFile(`{
	name: "t61hooks",
	apps: { ${web} },
	env: () => ({ ".env.local": { GREETING: "hello there" } }),
	hooks: {
		beforeUp: [${JSON.stringify(note("one"))}, ${JSON.stringify(note("two"))}, "echo said by beforeUp"],
		afterUp: ${JSON.stringify(note("after"))},
		beforeDown: ${JSON.stringify(note("stopping"))},
		afterDown: ${JSON.stringify(note("stopped"))},
	},
}`);
const local = (hooks: string) =>
	`export default (config) => ({ ...config, hooks: { ...config.hooks, ...${hooks} } });\n`;

let box: Sandbox;
let main: string;
let up: Result;
let down: Result;
let marker: string;

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
const read = async (dir: string) => {
	const text = await readFile(join(dir, "marker"), "utf8").catch(() => "");
	await rm(join(dir, "marker"), { force: true });
	return text;
};
const reset = async (dir: string) => {
	await rm(join(dir, "started"), { force: true });
	await rm(join(dir, "marker"), { force: true });
};

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t61hooks", {
		"basepad.config.ts": config,
		".gitignore": "node_modules\n.env.local\nmarker\nstarted\nbasepad.config.local.ts\n",
	});
	up = await box.basepad(main, "up");
	down = await box.basepad(main, "down");
	marker = await read(main);
}, 300_000);
afterAll(() => box?.dispose());

test("`up` runs beforeUp's commands in order before the apps start, then afterUp once they have, each with its event, environment and env file keys, and stdin closed", () => {
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect(marker).toBe(
		[
			"one beforeUp main hello there waiting stdin=1",
			"two beforeUp main hello there waiting stdin=1",
			"after afterUp main hello there started stdin=1",
			"stopping beforeDown main hello there started stdin=1",
			"stopped afterDown main hello there started stdin=1",
			"",
		].join("\n"),
	);
});

test("a hook's output goes where basepad's messages go", () => {
	expect(up.stdout).toContain("said by beforeUp");
	expect(up.stdout.indexOf("said by beforeUp")).toBeLessThan(up.stdout.indexOf("APP"));
});

test("`down` runs beforeDown and afterDown around stopping", async () => {
	expect(down.stderr).toBe("");
	expect(down.code).toBe(0);
});

test("a failed beforeUp cancels `up`: no app starts, and the rest of its commands don't run", async () => {
	await reset(main);
	await writeFile(
		join(main, "basepad.config.local.ts"),
		local(`{ beforeUp: ["echo nope; exit 4", "echo never >> marker"] }`),
	);
	const out = await box.basepad(main, "up");
	expect(out.code).toBe(1);
	expect(out.stdout).toContain("nope");
	expect(out.stderr).toContain("beforeUp `echo nope; exit 4` failed (exit 4)");
	expect(await read(main)).toBe("");
	expect(existsSync(join(main, "started"))).toBe(false);
	expect((await box.basepad(main, "status")).stdout).toMatch(/web +\S+ +stopped/);
});

test("a failed afterUp makes `up` exit 1 with its apps left running", async () => {
	await reset(main);
	await writeFile(join(main, "basepad.config.local.ts"), local(`{ afterUp: "exit 5" }`));
	const out = await box.basepad(main, "up");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("afterUp `exit 5` failed (exit 5)");
	expect(out.stdout).toMatch(/web +\S+ +running/);
	expect((await box.basepad(main, "status")).stdout).toMatch(/web +\S+ +running/);
});

test("failed Down hooks only warn: `down` stops everything and exits 0", async () => {
	await writeFile(
		join(main, "basepad.config.local.ts"),
		local(`{ beforeDown: "exit 6", afterDown: ["exit 7", "echo after-down-ran >> marker"] }`),
	);
	await read(main);
	const out = await box.basepad(main, "down");
	expect(out.code).toBe(0);
	expect(out.stderr).toContain("beforeDown `exit 6` failed (exit 6)");
	expect(out.stderr).toContain("afterDown `exit 7` failed (exit 7)");
	expect(await read(main)).toBe("");
	expect((await box.basepad(main, "status")).stdout).toMatch(/web +\S+ +stopped/);
});

test("afterUp is skipped when an app fails to start", async () => {
	await reset(main);
	await writeFile(
		join(main, "basepad.config.local.ts"),
		`export default (config) => ({ ...config, apps: { web: { run: "exit 1" } } });\n`,
	);
	const out = await box.basepad(main, "up");
	expect(out.code).toBe(1);
	expect(await read(main)).toMatch(/^one beforeUp .*\ntwo beforeUp .*\n$/);
	await box.basepad(main, "down");
	await rm(join(main, "basepad.config.local.ts"));
});

test("`worktree add --start` runs no Up hooks; `up` in the worktree runs them there, as its environment", async () => {
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	await reset(main);
	const added = await box.basepad(main, "worktree", "add", "--start");
	expect(added.code).toBe(0);
	const tree = join(box.root, "t61hooks.worktrees/worktree-1");
	expect(await read(tree)).toBe("");
	expect(await read(main)).toBe("");
	await box.basepad(tree, "down");
	await reset(tree);
	expect((await box.basepad(tree, "up")).code).toBe(0);
	expect(await read(tree)).toContain("after afterUp worktree-1 hello there started stdin=1\n");
	await box.basepad(tree, "down");
	await box.basepad(main, "down");
});
