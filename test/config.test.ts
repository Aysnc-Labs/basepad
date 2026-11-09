import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockOf, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

/** The lines of a new Laravel app's `.env` that basepad's block has to win over. */
const laravelEnv = [
	"APP_NAME=Laravel",
	"APP_URL=http://localhost",
	"",
	"DB_CONNECTION=sqlite",
	"",
	"REDIS_CLIENT=phpredis",
	"REDIS_HOST=127.0.0.1",
	"",
	"MAIL_MAILER=log",
	"MAIL_HOST=127.0.0.1",
	"MAIL_PORT=2525",
	"",
].join("\n");

describe("the laravel preset", () => {
	test("writes .env with Laravel's names, after the app's own lines", async () => {
		const blog = await box.project("blog", { ".env": laravelEnv });
		const add = await box.basepad(
			blog,
			"add",
			"postgres",
			"mailpit",
			"redis",
			"--preset",
			"laravel",
		);
		expect(add.stderr).toBe("");
		expect(add.code).toBe(0);

		const envFile = await readFile(join(blog, ".env"), "utf8");
		expect(envFile.startsWith(laravelEnv)).toBe(true);
		const block = blockOf(envFile);
		expect(Object.keys(block)).toEqual([
			"DB_CONNECTION",
			"DB_URL",
			"MAIL_MAILER",
			"MAIL_HOST",
			"MAIL_PORT",
			"MAIL_USERNAME",
			"MAIL_PASSWORD",
			"REDIS_URL",
			"APP_URL",
			"SERVER_PORT",
		]);
		expect(block).toMatchObject({
			DB_CONNECTION: "pgsql",
			MAIL_MAILER: "smtp",
			MAIL_HOST: "127.0.0.1",
			MAIL_USERNAME: "blog",
		});
		expect(block.DB_URL).toMatch(/^postgres:\/\/postgres:[^@]+@localhost:\d+\/blog$/);
		expect(block.MAIL_PORT).toMatch(/^\d+$/);
		expect(block.MAIL_PASSWORD).not.toBe("");
		expect(block.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
		expect(block.APP_URL).toBe(`http://localhost:${block.SERVER_PORT}`);

		expect((await box.psql(block.DB_URL as string, "select 1")).stdout.trim()).toBe("1");
		expect((await box.redis(block.REDIS_URL as string, "PING")).stdout.trim()).toBe("PONG");
		await expect(access(join(blog, ".env.local"))).rejects.toThrow();
		const config = await readFile(join(blog, "basepad.toml"), "utf8");
		expect(config).toMatch(/^preset = "laravel"$/m);
	});
});

describe("basepad.toml", () => {
	test("a Postgres service with several databases, a named Redis and renames", async () => {
		const config = [
			"# Our services",
			"[services.postgres]",
			'databases = ["app", "audit"]',
			"",
			"[services.cache]",
			'type = "redis"',
			'copy = "shared"',
			"",
			"[rename]",
			'AUDIT_DATABASE_URL = "LOGS_DATABASE_URL"',
			"",
		].join("\n");
		const ledger = await box.project("ledger", { "basepad.toml": config });

		const up = await box.basepad(ledger, "up");
		expect(up.stderr).toBe("");
		expect(up.code).toBe(0);
		const block = blockOf(await readFile(join(ledger, ".env.local"), "utf8"));
		expect(Object.keys(block)).toEqual(["APP_DATABASE_URL", "LOGS_DATABASE_URL", "CACHE_URL"]);
		for (const [key, db] of [
			["APP_DATABASE_URL", "ledger_app"],
			["LOGS_DATABASE_URL", "ledger_audit"],
		] as const) {
			const select = await box.psql(block[key] as string, "select current_database()");
			expect(select.stdout.trim()).toBe(db);
		}

		expect((await box.basepad(ledger, "add", "mailpit")).code).toBe(0);
		const after = await readFile(join(ledger, "basepad.toml"), "utf8");
		expect(after.startsWith(config)).toBe(true);
		expect(Object.keys(blockOf(await readFile(join(ledger, ".env.local"), "utf8")))).toEqual([
			"APP_DATABASE_URL",
			"LOGS_DATABASE_URL",
			"CACHE_URL",
			"SMTP_URL",
		]);

		const status = await box.basepad(ledger, "status");
		expect(status.stdout).toMatch(/^postgres\/app +running .*\/ledger_app$/m);
		expect(status.stdout).toMatch(/^postgres\/audit +running .*\/ledger_audit$/m);
	});

	test("refuses a copy strategy the service can't use", async () => {
		const bad = await box.project("bad", {
			"basepad.toml": '[services.redis]\ncopy = "copy"\n',
		});
		const up = await box.basepad(bad, "up");
		expect(up.code).toBe(1);
		expect(up.stderr).toContain(
			'can\'t use `copy = "copy"`. A redis service can use: empty, shared.',
		);
	});

	test("basepad up without one says how to start", async () => {
		const empty = await box.project("empty");
		const up = await box.basepad(empty, "up");
		expect(up.code).toBe(1);
		expect(up.stderr).toContain(
			"No basepad.toml here. Add a service with `basepad add <service>`.",
		);
	});
});
