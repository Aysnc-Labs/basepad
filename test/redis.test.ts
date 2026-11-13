import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");

const config = `import { defineConfig, redis } from "@aysnc-labs/basepad";

export default defineConfig({
	name: "t24cache",
	services: { cache: redis(), ref: redis({ worktree: "shared" }) },
	apps: { web: { run: ${JSON.stringify(`exec '${process.execPath}' '${echo}'`)} } },
	env: ({ cache, ref }) => ({
		".env.local": {
			REDIS_URL: cache.url,
			REDIS_HOST: cache.host,
			REDIS_PORT: cache.port,
			REF_URL: ref.url,
		},
	}),
});
`;

let box: Sandbox;
let main: string;
/** The worktree `worktree add` made. */
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

/** `redis-cli` against `url`, its reply trimmed; fails the test on any error. */
async function redisCli(url: string, ...args: string[]): Promise<string> {
	const out = await box.redis(url, ...args);
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	return out.stdout.trim();
}

/** Whether a Redis answers at `url`. */
async function answers(url: string): Promise<boolean> {
	const out = await box.redis(url, "PING");
	return out.code === 0 && out.stdout.trim() === "PONG";
}

const env = (dir: string) => readEnv(dir, ".env.local");

/** The proxy's URL for `host`, with its port. */
const url = (host: string) => `https://${host}:${box.proxyPort}`;

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t24cache", {
		"basepad.config.ts": config,
		".gitignore": "node_modules\n.env.local\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	tree = join(box.root, "t24cache.worktrees/worktree-1");
}, 300_000);

afterAll(async () => {
	await box?.dispose();
});

test("up runs the environment's own Redis, and a client sets and gets through the written URL", async () => {
	const vars = await env(main);
	expect(vars.REDIS_URL).toBe(`redis://127.0.0.1:${vars.REDIS_PORT}`);
	expect(vars.REDIS_HOST).toBe("127.0.0.1");
	const cache = vars.REDIS_URL as string;
	expect(await redisCli(cache, "SET", "who", "main")).toBe("OK");
	expect(await redisCli(cache, "GET", "who")).toBe("main");
	expect(await redisCli(vars.REF_URL as string, "SET", "who", "main")).toBe("OK");
	const status = await box.basepad(main, "status");
	expect(status.stdout).toMatch(new RegExp(`^cache +${cache} +running$`, "m"));
});

test("a worktree's Redis is its own and empty, started with the worktree; a shared one is main's", async () => {
	const added = await box.basepad(main, "worktree", "add");
	expect(added.stderr).toBe("");
	expect(added.code).toBe(0);
	const mains = await env(main);
	const own = await env(tree);
	expect(own.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
	expect(own.REDIS_URL).not.toBe(mains.REDIS_URL);
	expect(own.REF_URL).toBe(mains.REF_URL);
	// Made, not started: its Redis waits for the worktree.
	expect(await answers(own.REDIS_URL as string)).toBe(false);
	const idle = await box.basepad(tree, "status");
	expect(idle.stdout).toMatch(new RegExp(`^cache +${own.REDIS_URL} +stopped$`, "m"));
	expect(idle.stdout).toMatch(new RegExp(`^ref +${mains.REF_URL} +running$`, "m"));

	// The first request to its app starts the app and, before it, its Redis.
	await box.get(url("web.worktree-1.t24cache.localhost"));
	expect(await redisCli(own.REDIS_URL as string, "EXISTS", "who")).toBe("0");
	expect(await redisCli(own.REF_URL as string, "GET", "who")).toBe("main");
});

test("down in a worktree stops its Redis and leaves main's; up starts it again at the same URL", async () => {
	const own = await env(tree);
	const down = await box.basepad(tree, "down");
	expect(down.stderr).toBe("");
	expect(down.stdout).toContain("Stopped worktree worktree-1's apps and `cache`.");
	expect(await answers(own.REDIS_URL as string)).toBe(false);
	expect(await answers((await env(main)).REDIS_URL as string)).toBe(true);

	const up = await box.basepad(tree, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect((await env(tree)).REDIS_URL).toBe(own.REDIS_URL);
	expect(await answers(own.REDIS_URL as string)).toBe(true);
	const status = await box.basepad(tree, "status");
	expect(status.stdout).toMatch(new RegExp(`^cache +${own.REDIS_URL} +running$`, "m"));
});

test("a taken port moves Redis to the next free one, and the env file follows", async () => {
	const before = (await env(main)).REDIS_URL as string;
	const port = Number(new URL(before).port);
	expect((await box.basepad(main, "down")).code).toBe(0);
	const squatter = createServer();
	await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
	try {
		const up = await box.basepad(main, "up");
		expect(up.stderr).toBe("");
		expect(up.code).toBe(0);
		const after = (await env(main)).REDIS_URL as string;
		expect(Number(new URL(after).port)).toBeGreaterThan(port);
		expect(await redisCli(after, "SET", "moved", "yes")).toBe("OK");
	} finally {
		await new Promise((resolve) => squatter.close(resolve));
	}
});

test("worktree rm stops and removes the worktree's Redis, and leaves main's", async () => {
	const own = (await env(tree)).REDIS_URL as string;
	const rm = await box.basepad(main, "worktree", "rm", "worktree-1", "--force");
	expect(rm.stderr).toBe("");
	expect(rm.code).toBe(0);
	expect(await answers(own)).toBe(false);
	expect(await answers((await env(main)).REDIS_URL as string)).toBe(true);
	const status = await box.basepad(main, "status");
	expect(status.stdout).not.toContain("worktree-1");
});
