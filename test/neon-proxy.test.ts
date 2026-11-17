import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const script = join(import.meta.dirname, "apps/neon-query.mjs");

const config = configFile(`{
	name: "neon-proxy",
	services: { db: postgresWithNeonProxy() },
	env: ({ db }) => ({
		".env.local": { DATABASE_URL: db.url, NEON_WS_PROXY: db.wsProxy, DIRECT_URL: db.directUrl },
	}),
}`);

let box: Sandbox;
let main: string;
let firstUp: Result;

const env = () => readEnv(main, ".env.local");

async function throughProxy(sql: string): Promise<Result> {
	const vars = await env();
	return box.run(process.execPath, [
		script,
		vars.DATABASE_URL as string,
		vars.NEON_WS_PROXY as string,
		sql,
	]);
}

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("neon-proxy", { "basepad.config.ts": config });
	firstUp = await box.basepad(main, "up");
}, 300_000);
afterAll(() => box?.dispose());

test("up writes the driver's url, the proxy's address and a direct url", async () => {
	expect(firstUp.stderr).toBe("");
	expect(firstUp.code).toBe(0);
	const vars = await env();
	const port = new URL(vars.DIRECT_URL as string).port;
	expect(vars.DIRECT_URL).toBe(`postgresql://postgres:basepad@127.0.0.1:${port}/neon_proxy_db`);
	expect(vars.DATABASE_URL).toBe(
		`postgresql://postgres:basepad@localhost:${port}/neon_proxy_db?options=endpoint%3Dlocal`,
	);
	expect(vars.NEON_WS_PROXY).toMatch(/^localhost:\d+\/v2$/);
});

test("the serverless driver reads main's row through the proxy", async () => {
	const made = await box.psql(
		[(await env()).DIRECT_URL as string],
		"create table notes (body text); insert into notes values ('hello from main')",
	);
	expect(made.stderr).toBe("");
	const out = await throughProxy(
		"select current_database() as db, (select body from notes) as note",
	);
	expect(out.stderr).toBe("");
	expect(JSON.parse(out.stdout)).toEqual([{ db: "neon_proxy_db", note: "hello from main" }]);
});

test("psql connects with directUrl, and Postgres refuses url's proxy options", async () => {
	const vars = await env();
	const direct = await box.psql([vars.DIRECT_URL as string], "select 1");
	expect(direct.stdout.trim()).toBe("1");
	const refused = await box.psql([vars.DATABASE_URL as string], "select 1");
	expect(refused.code).not.toBe(0);
	expect(refused.stderr).toContain("invalid command-line argument for server process");
});

test("status lists the proxy with its address, and down stops it", async () => {
	const proxy = (await env()).NEON_WS_PROXY as string;
	const status = await box.basepad(main, "status");
	expect(status.stdout).toMatch(
		new RegExp(`^db-neon-proxy +ws://${proxy.replaceAll("/", "\\/")} +running$`, "m"),
	);
	const down = await box.basepad(main, "down");
	expect(down.code).toBe(0);
	const after = await box.basepad(main, "status");
	expect(after.stdout).toMatch(/^db-neon-proxy +ws:\/\/\S+ +stopped$/m);
	expect((await throughProxy("select 1")).code).not.toBe(0);
});
