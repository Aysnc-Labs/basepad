import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, MISE_TOML, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box?.dispose());

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

test("a Remove hook sees the worktree's env file keys even when main's mise config loads main's env file", async () => {
	const main = await box.project("t67rmkeys", {
		"basepad.config.ts": configFile(`{
			name: "t67rmkeys",
			apps: { web: { run: "sleep 60" } },
			env: ({ web }) => ({ ".env.local": { WEB_URL: web.url } }),
			hooks: { beforeRemove: 'echo "$WEB_URL" >> removed' },
		}`),
		"mise.toml": `${MISE_TOML}\n[env]\n_.file = ".env.local"\n`,
		".gitignore": "node_modules\n.env.local\nremoved\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	expect((await box.basepad(main, "worktree", "add")).code).toBe(0);

	expect((await box.basepad(main, "worktree", "rm", "worktree-1", "--force")).code).toBe(0);

	expect(await readFile(join(main, "removed"), "utf8")).toMatch(
		/^https:\/\/web\.worktree-1\.t67rmkeys\.localhost(:\d+)?\n$/,
	);
	await box.basepad(main, "down");
}, 300_000);

test("an app gets basepad's PORT even when its checkout's mise config sets PORT", async () => {
	const echo = join(import.meta.dirname, "apps/echo.mjs");
	const dir = await box.project("t67appport", {
		"basepad.config.ts": configFile(`{
			name: "t67appport",
			apps: { web: { run: ${JSON.stringify(`echo "$PORT" > port && exec '${process.execPath}' '${echo}'`)} } },
		}`),
		"mise.toml": `${MISE_TOML}\n[env]\nPORT = "11111"\n`,
	});

	await box.basepad(dir, "up");

	expect(await readFile(join(dir, "port"), "utf8")).toMatch(/^2\d{4}\n$/);
	await box.basepad(dir, "down");
}, 120_000);
