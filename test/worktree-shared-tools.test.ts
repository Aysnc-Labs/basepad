import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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

const redisServer = (version: string) =>
	new RegExp(`/conda-redis-server/${version.replaceAll(".", "\\.")}/\\S*redis-server`);

test("a worktree whose shared service resolves another program than main's fails to come up, naming both", async () => {
	const main = await box.project("t57tools", {
		"basepad.config.ts": configFile(`{
			name: "t57tools",
			services: { cache: redis({ worktree: "shared" }) },
			env: ({ cache }) => ({ ".env.local": { REDIS_URL: cache.url } }),
			hooks: { beforeCreate: "touch created" },
		}`),
		".gitignore": "node_modules\n.env.local\ncreated\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	await git(main, "checkout", "--quiet", "-b", "older");
	await writeFile(
		join(main, "mise.toml"),
		MISE_TOML.replace('"conda:redis-server" = "8.10.3"', '"conda:redis-server" = "8.10.2"'),
	);
	await git(main, "commit", "--quiet", "-am", "older redis");
	await git(main, "checkout", "--quiet", "main");

	const mainUp = await box.basepad(main, "up", "-d");
	expect(mainUp.stderr).toBe("");

	const add = await box.basepad(main, "worktree", "add", "--branch", "older");
	expect(add.code).toBe(1);
	expect(add.stderr).toContain("`cache`");
	expect(add.stderr).toMatch(redisServer("8.10.2"));
	expect(add.stderr).toMatch(redisServer("8.10.3"));
	expect(add.stderr).toContain("main");
	const tree = join(box.root, "t57tools.worktrees/worktree-1");
	expect(existsSync(join(tree, "created"))).toBe(false);

	const up = await box.basepad(tree, "up", "-d");
	expect(up.code).toBe(1);
	expect(up.stderr).toContain("`cache`");
	expect(up.stderr).toMatch(redisServer("8.10.2"));
	expect(up.stderr).toMatch(redisServer("8.10.3"));

	expect((await box.basepad(tree, "status")).code).toBe(0);
	expect((await box.basepad(tree, "down")).code).toBe(0);
}, 300_000);

test("a worktree whose mise config isn't trusted fails before beforeCreate runs", async () => {
	const main = await box.project("t57trust", {
		"basepad.config.ts": configFile(
			`{ name: "t57trust", hooks: { beforeCreate: "touch created" } }`,
		),
		".gitignore": "node_modules\ncreated\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	const onlyMainTrusted = {
		CI: undefined,
		CONTINUOUS_INTEGRATION: undefined,
		GITHUB_ACTIONS: undefined,
		BUILD_NUMBER: undefined,
		RUN_ID: undefined,
		MISE_PARANOID: "1",
		MISE_TRUSTED_CONFIG_PATHS: main,
	};

	const add = await box.basepadWith({ env: onlyMainTrusted }, main, "worktree", "add");

	const tree = join(box.root, "t57trust.worktrees/worktree-1");
	expect(add.code).toBe(1);
	expect(add.stderr).toContain(`Config files in ${join(tree, "mise.toml")} are not trusted.`);
	expect(add.stderr).toContain(`\`mise trust ${join(tree, "mise.toml")}\``);
	expect(existsSync(join(tree, "created"))).toBe(false);
}, 120_000);
