import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

/**
 * An app with `domain: false`, such as Vite behind another app's page: it serves HTTPS itself at
 * `https://localhost:$PORT`, with a certificate basepad gives it, and has no domain.
 */

const node = (script: string) =>
	JSON.stringify(`exec '${process.execPath}' '${join(import.meta.dirname, "apps", script)}'`);

let box: Sandbox;
let assets: string;
let up: Result;

beforeAll(async () => {
	box = await sandbox();
	assets = await box.project("assets", {
		"basepad.config.ts": configFile(`{
			name: "assets",
			apps: {
				web: { run: ${node("echo.mjs")} },
				vite: { run: ${node("tls.mjs")}, domain: false },
			},
			env: ({ web }) => ({ ".env": { APP_URL: web.url } }),
		}`),
		".gitignore": "node_modules\n.env\ntls.json\n",
	});
	for (const args of [
		["init", "--quiet"],
		["add", "."],
		["commit", "--quiet", "-m", "init"],
	]) {
		await promisify(execFile)("git", args, {
			cwd: assets,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
	}
	up = await box.basepad(assets, "up");
}, 300_000);
afterAll(() => box?.dispose());

test("up runs it on its PORT with no domain, and shows it running with no URL", () => {
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect(up.stdout).toMatch(/^vite +running$/m);
	expect(up.stdout).not.toContain("vite.assets.localhost");
});

test("the proxy has no route for it", async () => {
	await expect(box.get(`https://vite.assets.localhost:${box.proxyPort}/`)).rejects.toThrow(/404/);
});

test("it serves HTTPS at localhost with a certificate signed by basepad's CA", async () => {
	const { port } = JSON.parse(await readFile(join(assets, "tls.json"), "utf8"));
	expect(await box.get(`https://localhost:${port}/`)).toEqual({ cwd: assets });
});

test("in a worktree, it starts with the first request to one of the worktree's domains", async () => {
	const added = await box.basepad(assets, "worktree", "add");
	expect(added.stderr).toBe("");
	const tree = join(box.root, "assets.worktrees/worktree-1");
	expect(existsSync(join(tree, "tls.json"))).toBe(false);
	// The proxy may not route a worktree's domain for a moment after it is made.
	const web = `https://web.worktree-1.assets.localhost:${box.proxyPort}`;
	for (const until = Date.now() + 10_000; ; ) {
		try {
			await box.get(web);
			break;
		} catch (error) {
			if (Date.now() > until) throw error;
		}
	}
	const { port } = JSON.parse(await readFile(join(tree, "tls.json"), "utf8"));
	expect(await box.get(`https://localhost:${port}/`)).toEqual({ cwd: tree });
});
