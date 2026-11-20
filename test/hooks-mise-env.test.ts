import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
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

test("`down` runs no hook through an untrusted mise config, and trusts nothing", async () => {
	const dir = await box.project("untrusted-down", {
		"basepad.config.ts": configFile(`{
			name: "t67untrusteddown",
			hooks: { beforeDown: "touch hooked", afterDown: "touch hooked" },
		}`),
		"mise.toml": `${MISE_TOML}\n[env]\nRAN = "{{ exec(command='touch from-mise && echo x') }}"\n`,
	});

	const down = await box.basepadWith({ env: box.untrusted() }, dir, "down");

	expect(down.code).toBe(0);
	expect(down.stderr).toContain(`basepad: mise doesn't trust the mise config at ${dir}`);
	expect(down.stderr).toContain("Skipping beforeDown.");
	expect(down.stderr).toContain("Skipping afterDown.");

	expect(existsSync(join(dir, "from-mise"))).toBe(false);
	expect(existsSync(join(dir, "hooked"))).toBe(false);
	const trusted = join(box.env.MISE_STATE_DIR as string, "trusted-configs");
	expect(existsSync(trusted) ? await readdir(trusted) : []).toEqual([]);
}, 120_000);

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

test("a Remove hook gets an empty key, not main's, when the worktree's env file is gone", async () => {
	const main = await box.project("t67rmgone", {
		"basepad.config.ts": configFile(`{
			name: "t67rmgone",
			apps: { web: { run: "sleep 60" } },
			env: ({ web }) => ({ ".env.local": { WEB_URL: web.url } }),
			hooks: { beforeRemove: 'echo "[$WEB_URL]" >> removed' },
		}`),
		"mise.toml": `${MISE_TOML}\n[env]\n_.file = ".env.local"\n`,
		".gitignore": "node_modules\n.env.local\nremoved\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	expect((await box.basepad(main, "worktree", "add")).code).toBe(0);
	const tree = join(box.root, "t67rmgone.worktrees/worktree-1");
	await box.basepad(tree, "down");
	await rm(tree, { recursive: true, force: true });

	expect((await box.basepad(main, "prune", "--yes")).code).toBe(0);

	expect(await readFile(join(main, "removed"), "utf8")).toBe("[]\n");
	await box.basepad(main, "down");
}, 300_000);

test("a hook gets the env file keys when `env` builds a value from an output", async () => {
	const dir = await box.project("t67keys", {
		"basepad.config.ts": configFile(`{
			name: "t67keys",
			apps: { web: { run: "sleep 60" } },
			env: ({ web }) => ({
				".env.local": { WEB_URL: web.url, WEB_HOST: new URL(web.url).hostname },
			}),
			hooks: { afterUp: 'echo "$WEB_URL $WEB_HOST" > keys' },
		}`),
	});

	expect((await box.basepad(dir, "up")).code).toBe(0);

	expect(await readFile(join(dir, "keys"), "utf8")).toMatch(
		/^https:\/\/web\.t67keys\.localhost(:\d+)? web\.t67keys\.localhost\n$/,
	);
	await box.basepad(dir, "down");
}, 120_000);

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

test("a hook warns once that it gets no env file keys when `env` throws on basepad's placeholders", async () => {
	const dir = await box.project("t67envthrows", {
		"basepad.config.ts": configFile(`{
			name: "t67envthrows",
			apps: { web: { run: "sleep 60" } },
			env: ({ web }) => {
				if (!web.url.startsWith("https://")) throw new Error("web.url isn't https");
				return { ".env.local": { WEB_URL: web.url } };
			},
			hooks: { beforeUp: "true", afterUp: "true" },
		}`),
	});

	const up = await box.basepad(dir, "up");

	expect(up.code).toBe(0);
	expect(up.stderr).toBe(
		"basepad: hooks get no env file keys: `env` threw on basepad's placeholder outputs: web.url isn't https\n",
	);
	await box.basepad(dir, "down");
}, 120_000);
