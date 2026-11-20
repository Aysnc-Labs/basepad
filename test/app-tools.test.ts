import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const run = `jq --version > jq-version && exec '${process.execPath}' '${echo}'`;
const tools = (jq: string) => `[tools]\njq = "${jq}"\n`;

let box: Sandbox;
let main: string;
let tree: string;
let mainUp: Result;
let treeUp: Result;

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

beforeAll(async () => {
	box = await sandbox();
	box.env.MISE_TRUSTED_CONFIG_PATHS = box.root;
	main = await box.project("t60tools", {
		"basepad.config.ts": configFile(`{
			name: "t60tools",
			apps: { web: { run: ${JSON.stringify(run)} } },
		}`),
		"mise.toml": tools("1.7.1"),
		".gitignore": "node_modules\njq-version\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	await box.basepad(main, "worktree", "add");
	tree = join(box.root, "t60tools.worktrees/worktree-1");
	await writeFile(join(tree, "mise.toml"), tools("1.6"));
	for (const dir of [main, tree]) {
		const installed = await box.run("sh", ["-c", `cd '${dir}' && mise install --quiet`]);
		expect(installed.stderr).toBe("");
	}
	mainUp = await box.basepad(main, "up");
	treeUp = await box.basepad(tree, "up");
}, 300_000);
afterAll(() => box?.dispose());

test("an app runs the tools its checkout's mise config pins, not the ones on PATH", async () => {
	expect(mainUp.stderr).toBe("");
	expect(mainUp.code).toBe(0);
	expect(await readFile(join(main, "jq-version"), "utf8")).toBe("jq-1.7.1\n");
});

test("an app in a worktree runs the worktree's tools", async () => {
	expect(treeUp.stderr).toBe("");
	expect(treeUp.code).toBe(0);
	expect(await readFile(join(tree, "jq-version"), "utf8")).toBe("jq-1.6\n");
});
