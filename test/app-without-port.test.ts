import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

/** An app with `port: false`, such as a queue worker: it runs, but listens on nothing. */

const node = (script: string) =>
	JSON.stringify(`exec '${process.execPath}' '${join(import.meta.dirname, "apps", script)}'`);

let box: Sandbox;
let jobs: string;
let up: Result;

beforeAll(async () => {
	box = await sandbox();
	jobs = await box.project("jobs", {
		"basepad.config.ts": configFile(`{
			name: "jobs",
			apps: {
				web: { run: ${node("echo.mjs")} },
				queue: { run: ${node("worker.mjs")}, port: false },
			},
			env: ({ web }) => ({ ".env": { APP_URL: web.url } }),
		}`),
		".gitignore": "node_modules\n.env\nworker.json\n",
	});
	for (const args of [
		["init", "--quiet"],
		["add", "."],
		["commit", "--quiet", "-m", "init"],
	]) {
		await promisify(execFile)("git", args, {
			cwd: jobs,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
	}
	up = await box.basepad(jobs, "up");
}, 300_000);
afterAll(() => box?.dispose());

test("up runs it with no PORT, and shows it running with no URL", async () => {
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect(up.stdout).toMatch(/^queue +running$/m);
	expect(up.stdout).not.toContain("queue.jobs.localhost");
	const worker = JSON.parse(await readFile(join(jobs, "worker.json"), "utf8"));
	expect(worker.port).toBeNull();
	expect((await box.basepad(jobs, "status")).stdout).toMatch(/^queue +running$/m);
});

test("in a worktree, it starts with the first request to one of the worktree's domains", async () => {
	const added = await box.basepad(jobs, "worktree", "add");
	expect(added.stderr).toBe("");
	const tree = join(box.root, "jobs.worktrees/worktree-1");
	expect(existsSync(join(tree, "worker.json"))).toBe(false);
	// The proxy may not route a worktree's domain for a moment after it is made.
	const web = `https://web.worktree-1.jobs.localhost:${box.proxyPort}`;
	for (const until = Date.now() + 10_000; ; ) {
		try {
			await box.get(web);
			break;
		} catch (error) {
			if (Date.now() > until) throw error;
		}
	}
	expect((await box.basepad(tree, "status")).stdout).toMatch(/^queue +running$/m);
	expect(existsSync(join(tree, "worker.json"))).toBe(true);
});
