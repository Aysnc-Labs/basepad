import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, MISE_TOML, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

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

async function redisVersion(dir: string): Promise<string | undefined> {
	const url = (await readEnv(dir, ".env.local")).REDIS_URL as string;
	const info = await box.redis(url, "INFO", "server");
	return info.stdout.match(/^redis_version:(\S+)/m)?.[1];
}

test("a worktree's own Redis runs the redis-server its own mise config gives", async () => {
	const main = await box.project("t56tools", {
		"basepad.config.ts": configFile(`{
			name: "t56tools",
			services: { cache: redis() },
			env: ({ cache }) => ({ ".env.local": { REDIS_URL: cache.url } }),
		}`),
		".gitignore": "node_modules\n.env.local\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	const tree = join(box.root, "t56tools.worktrees/older");
	await git(main, "worktree", "add", "--quiet", "-b", "older", tree);
	await writeFile(
		join(tree, "mise.toml"),
		MISE_TOML.replace('redis = "8.10.3-1"', '"conda:redis-server" = "8.10.2"'),
	);

	const mainUp = await box.basepad(main, "up", "-d");
	expect(mainUp.stderr).toBe("");
	const treeUp = await box.basepad(tree, "up", "-d");
	expect(treeUp.stderr).toBe("");

	expect(await redisVersion(main)).toBe("8.10.3");
	expect(await redisVersion(tree)).toBe("8.10.2");
}, 300_000);
