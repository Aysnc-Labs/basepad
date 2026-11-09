import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockOf, type Sandbox, sandbox } from "./sandbox.ts";

/** The variables the test hooks write down. */
const HOOK_VARS =
	"^(BASEPAD_WORKTREE|BASEPAD_WORKTREE_PATH|BASEPAD_MAIN_PATH|DATABASE_URL|REDIS_URL|SMTP_URL|PORT)=";

let box: Sandbox;
let main: string;
let mainVars: Record<string, string>;

beforeAll(async () => {
	box = await sandbox();
	main = await box.repo("shop", {
		"basepad.toml": [
			"[services.postgres]",
			"[services.redis]",
			"[services.mailpit]",
			"[services.scratch]",
			'type = "postgres"',
			'copy = "empty"',
			"[services.audit]",
			'type = "postgres"',
			'copy = "shared"',
			"[services.cache]",
			'type = "redis"',
			'copy = "shared"',
			"",
		].join("\n"),
		".gitignore": [
			".env.local",
			".config/mise/conf.d/",
			"secret.txt",
			"build-cache/",
			"hook-*.txt",
			"",
		].join("\n"),
		"mise.toml": [
			'[tasks."basepad:post-create"]',
			`run = "env | grep -E '${HOOK_VARS}' | sort > hook-post-create.txt && basepad clone build-cache"`,
			'[tasks."basepad:post-start"]',
			'run = "date > hook-post-start.txt"',
			'[tasks."basepad:pre-remove"]',
			`run = "env | grep -E '${HOOK_VARS}' | sort > $BASEPAD_MAIN_PATH/hook-pre-remove-$BASEPAD_WORKTREE.txt"`,
			"",
		].join("\n"),
		".worktreeinclude": ["secret.txt", "notes.txt", ""].join("\n"),
	});
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	mainVars = blockOf(await readFile(join(main, ".env.local"), "utf8"));
	const seed = await box.psql(
		mainVars.DATABASE_URL as string,
		"create table orders (id int primary key); insert into orders select generate_series(1, 1000)",
	);
	expect(seed.stderr).toBe("");
	await writeFile(join(main, "secret.txt"), "from main\n");
	await writeFile(join(main, "notes.txt"), "untracked, not ignored\n");
	await mkdir(join(main, "build-cache"));
	await writeFile(join(main, "build-cache", "a.bin"), "cached\n");
});
afterAll(async () => {
	await box?.dispose();
});

const worktreePath = (name: string) => join(dirname(main), `${basename(main)}-${name}`);
const varsOf = async (dir: string) => blockOf(await readFile(join(dir, ".env.local"), "utf8"));
const envOf = async (file: string) =>
	Object.fromEntries(
		(await readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
const count = async (url: string, sql = "select count(*) from orders") =>
	(await box.psql(url, sql)).stdout.trim();

describe("basepad worktree add", () => {
	test("makes a worktree with a copy of main's database, its own Redis, port and mail tag", async () => {
		const add = await box.basepad(main, "worktree", "add", "feat-x");
		expect(add.code, add.stderr).toBe(0);
		const wt = worktreePath("feat-x");
		expect(add.stdout).toContain("shop_feat_x");
		expect(add.stdout).toMatch(/template/);

		const vars = await varsOf(wt);
		expect(vars.DATABASE_URL).toMatch(/^postgres:\/\/postgres:[^@]+@localhost:\d+\/shop_feat_x$/);
		expect(await count(vars.DATABASE_URL as string)).toBe("1000");
		expect(vars.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
		expect(vars.REDIS_URL).not.toBe(mainVars.REDIS_URL);
		expect((await box.redis(vars.REDIS_URL as string, "PING")).stdout.trim()).toBe("PONG");
		expect(new URL(vars.SMTP_URL as string).username).toBe("feat-x");
		expect(vars.PORT).toMatch(/^\d+$/);

		// The other copy strategies: an empty database of its own, and main's own database and Redis.
		expect(vars.SCRATCH_DATABASE_URL).toMatch(/\/shop_scratch_feat_x$/);
		expect(
			await count(
				vars.SCRATCH_DATABASE_URL as string,
				"select count(*) from pg_tables where schemaname = 'public'",
			),
		).toBe("0");
		expect(vars.AUDIT_DATABASE_URL).toBe(mainVars.AUDIT_DATABASE_URL);
		expect(vars.CACHE_URL).toBe(mainVars.CACHE_URL);

		expect(await readFile(join(wt, "secret.txt"), "utf8")).toBe("from main\n");
		await expect(access(join(wt, "notes.txt"))).rejects.toThrow();
		expect((await box.git(wt, "branch", "--show-current")).stdout.trim()).toBe("feat-x");
	});

	test("copies main's database while a client holds it open, without interrupting it, in budget", async () => {
		const client = await holdOpen(mainVars.DATABASE_URL as string);
		try {
			const started = Date.now();
			const add = await box.basepad(main, "worktree", "add", "feat-y");
			const seconds = (Date.now() - started) / 1000;
			expect(add.code, add.stderr).toBe(0);
			expect(add.stdout).toMatch(/dump and restore/);
			expect(seconds).toBeLessThan(30);

			const vars = await varsOf(worktreePath("feat-y"));
			expect(vars.DATABASE_URL).toMatch(/\/shop_feat_y$/);
			expect(await count(vars.DATABASE_URL as string)).toBe("1000");
			expect(await client.ask("select 'still here'")).toBe("still here");
		} finally {
			client.close();
		}
	});

	test("keeps two worktrees and main apart", async () => {
		const x = await varsOf(worktreePath("feat-x"));
		const y = await varsOf(worktreePath("feat-y"));
		await box.psql(x.DATABASE_URL as string, "insert into orders values (5000)");
		expect(await count(x.DATABASE_URL as string)).toBe("1001");
		expect(await count(y.DATABASE_URL as string)).toBe("1000");
		expect(await count(mainVars.DATABASE_URL as string)).toBe("1000");

		await box.redis(x.REDIS_URL as string, "SET", "who", "feat-x");
		expect((await box.redis(y.REDIS_URL as string, "EXISTS", "who")).stdout.trim()).toBe("0");
		expect((await box.redis(mainVars.REDIS_URL as string, "EXISTS", "who")).stdout.trim()).toBe(
			"0",
		);
		expect(new Set([x.PORT, y.PORT]).size).toBe(2);
		expect(new URL(y.SMTP_URL as string).username).toBe("feat-y");
	});

	test("runs the hooks with the worktree's variables, and they can clone from main", async () => {
		const wt = worktreePath("feat-x");
		const vars = await varsOf(wt);
		expect(await envOf(join(wt, "hook-post-create.txt"))).toEqual({
			BASEPAD_MAIN_PATH: main,
			BASEPAD_WORKTREE: "feat-x",
			BASEPAD_WORKTREE_PATH: wt,
			DATABASE_URL: vars.DATABASE_URL,
			PORT: vars.PORT,
			REDIS_URL: vars.REDIS_URL,
			SMTP_URL: vars.SMTP_URL,
		});
		expect(await readFile(join(wt, "build-cache", "a.bin"), "utf8")).toBe("cached\n");

		await rm(join(wt, "hook-post-start.txt"));
		const up = await box.basepad(wt, "up");
		expect(up.code, up.stderr).toBe(0);
		await access(join(wt, "hook-post-start.txt"));
		expect(await varsOf(wt)).toEqual(vars);
	});
});

describe("basepad clone", () => {
	test("copies paths from main into the worktree", async () => {
		const wt = worktreePath("feat-x");
		await writeFile(join(main, "build-cache", "b.bin"), "newer\n");
		await writeFile(join(main, "secret.txt"), "rotated\n");
		const clone = await box.basepad(join(wt, "build-cache"), "clone", ".", "../secret.txt");
		expect(clone.stderr).toBe("");
		expect(clone.code).toBe(0);
		expect(await readFile(join(wt, "build-cache", "b.bin"), "utf8")).toBe("newer\n");
		expect(await readFile(join(wt, "secret.txt"), "utf8")).toBe("rotated\n");

		const inMain = await box.basepad(main, "clone", "secret.txt");
		expect(inMain.code).toBe(1);
		expect(inMain.stderr).toContain("run `basepad clone` in a worktree");
	});
});

describe("basepad worktree ls and remove", () => {
	test("ls lists each worktree with its state, port and databases", async () => {
		const ls = await box.basepad(main, "worktree", "ls");
		expect(ls.stderr).toBe("");
		const x = await varsOf(worktreePath("feat-x"));
		expect(ls.stdout).toMatch(/^WORKTREE +STATE +PORT +REDIS +DATABASES +PATH$/m);
		const row = ls.stdout.split("\n").find((line) => line.startsWith("feat-x "));
		expect(row).toMatch(new RegExp(`^feat-x +ready +${x.PORT} +\\d+, \\d+ \\(shared\\) +`));
		expect(row).toContain("shop_feat_x, shop_scratch_feat_x, shop_audit (shared)");
		expect(row?.endsWith(` ${worktreePath("feat-x")}`)).toBe(true);
		expect(ls.stdout).toMatch(/^feat-y +ready +\d+ .* shop_feat_y, /m);
	});

	test("remove runs the pre-remove hook and leaves no database, port or record", async () => {
		const wt = worktreePath("feat-x");
		const vars = await varsOf(wt);
		const remove = await box.basepad(main, "worktree", "remove", "feat-x");
		expect(remove.code, remove.stderr).toBe(0);

		const hook = await envOf(join(main, "hook-pre-remove-feat-x.txt"));
		expect(hook).toMatchObject({ BASEPAD_WORKTREE: "feat-x", DATABASE_URL: vars.DATABASE_URL });
		await expect(access(wt)).rejects.toThrow();
		expect((await box.git(main, "worktree", "list")).stdout).not.toContain(wt);
		expect((await box.git(main, "branch", "--list", "feat-x")).stdout).toContain("feat-x");

		const databases = await box.psql(
			mainVars.DATABASE_URL as string,
			"select datname from pg_database order by 1",
		);
		expect(databases.stdout.split("\n")).not.toContain("shop_feat_x");
		expect(databases.stdout.split("\n")).toContain("shop_feat_y");
		expect((await box.redis(vars.REDIS_URL as string, "PING")).code).not.toBe(0);
		const records = await readFile(join(box.home, "basepad.json"), "utf8");
		expect(records).not.toContain(wt);
		expect(records).not.toContain(`"port": ${vars.PORT}`);
		expect(records).not.toContain(`:${new URL(vars.REDIS_URL as string).port}`);
		expect((await box.basepad(main, "worktree", "ls")).stdout).not.toContain("feat-x");
		expect(await count(mainVars.DATABASE_URL as string)).toBe("1000");
		// What it shared with main is main's, and stays.
		expect(databases.stdout.split("\n")).toContain("shop_audit");
		expect((await box.redis(mainVars.CACHE_URL as string, "PING")).stdout.trim()).toBe("PONG");
	});
});

/** A psql session on `url` that stays connected, idle, until closed. */
async function holdOpen(
	url: string,
): Promise<{ ask(sql: string): Promise<string>; close(): void }> {
	const child: ChildProcess = spawn(
		"mise",
		["exec", "postgres@18", "--", "psql", url, "-tAX", "-v", "ON_ERROR_STOP=1"],
		{ cwd: box.root, env: box.env, stdio: ["pipe", "pipe", "inherit"] },
	);
	let out = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		out += chunk;
	});
	const ask = async (sql: string) => {
		out = "";
		child.stdin?.write(`${sql};\n`);
		for (let i = 0; i < 100 && !out.includes("\n"); i++)
			await new Promise((r) => setTimeout(r, 100));
		return out.trim();
	};
	expect(await ask("select 'connected'")).toBe("connected");
	return { ask, close: () => child.stdin?.end() };
}
