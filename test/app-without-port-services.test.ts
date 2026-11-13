import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

/**
 * An app with `port: false` beside a worktree's own Redis and the project's Mailpit: the first
 * request to a worktree's app starts its worker and its Redis.
 */

const node = (script: string) =>
	JSON.stringify(`exec '${process.execPath}' '${join(import.meta.dirname, "apps", script)}'`);

let box: Sandbox;
let main: string;

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t35mix", {
		"basepad.config.ts": configFile(`{
	name: "t35mix",
	services: { cache: redis(), mail: mailpit() },
	apps: { web: { run: ${node("echo.mjs")} }, queue: { run: ${node("worker.mjs")}, port: false } },
	env: ({ web, cache, mail }) => ({
		".env.local": { APP_URL: web.url, REDIS_URL: cache.url, SMTP_URL: mail.url },
	}),
}`),
		".gitignore": "node_modules\n.env.local\nworker.json\n",
	});
	const git = (...args: string[]) =>
		promisify(execFile)("git", args, {
			cwd: main,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
	await git("init", "--quiet", "--initial-branch=main");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "init");
	const up = await box.basepad(main, "up", "-d");
	expect(up.stderr).toBe("");
	expect(up.stdout).toMatch(/^queue +running$/m);
	expect(up.stdout).toMatch(/^mail +https:\/\/mail\.t35mix\.localhost:\d+ +running$/m);
}, 300_000);
afterAll(() => box?.dispose());

test("a worktree's first request starts its worker and its own Redis", async () => {
	expect((await box.basepad(main, "worktree", "add")).code).toBe(0);
	const tree = join(box.root, "t35mix.worktrees/worktree-1");
	const redis = (await readEnv(tree, ".env.local")).REDIS_URL as string;
	expect(redis).not.toBe((await readEnv(main, ".env.local")).REDIS_URL);
	expect((await box.redis(redis, "PING")).code).not.toBe(0);
	const web = `https://web.worktree-1.t35mix.localhost:${box.proxyPort}`;
	for (const until = Date.now() + 15_000; ; ) {
		try {
			await box.get(web);
			break;
		} catch (error) {
			if (Date.now() > until) throw error;
		}
	}
	expect((await box.redis(redis, "PING")).stdout.trim()).toBe("PONG");
	expect((await box.basepad(tree, "status")).stdout).toMatch(/^queue +running$/m);
	expect(existsSync(join(tree, "worker.json"))).toBe(true);
}, 120_000);
