import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
let shop: string;
let firstUp: Result;

/** Each Postgres test file has its own name, so their derived ports differ. */
const config = configFile(`{
	name: "pg-shop",
	services: { db: postgres() },
	env: ({ db }) => ({
		".env.local": { DATABASE_URL: db.url },
		"backend/.env": {
			DB_HOST: db.host,
			DB_PORT: db.port,
			DB_DATABASE: db.database,
			DB_USERNAME: db.user,
			DB_PASSWORD: db.password,
		},
	}),
}`);

beforeAll(async () => {
	box = await sandbox();
	shop = await box.project("shop", { "basepad.config.ts": config });
	firstUp = await box.basepad(shop, "up");
}, 300_000);
afterAll(() => box?.dispose());

/** An env file's keys and values; values here are never quoted. */
async function env(dir: string, file: string): Promise<Record<string, string>> {
	const text = await readFile(join(dir, file), "utf8");
	return Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

async function sql(dir: string, query: string): Promise<string> {
	const out = await box.psql([(await env(dir, ".env.local")).DATABASE_URL as string], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

test("up runs the project's Postgres (18 by default, on loopback), and a client connects with the written URL", async () => {
	expect(firstUp.stderr).toBe("");
	expect(firstUp.code).toBe(0);
	expect(await sql(shop, "select current_database()")).toBe("pg_shop_db");
	expect(await sql(shop, "show server_version_num")).toMatch(/^18\d{4}$/);
	expect(await sql(shop, "show listen_addresses")).toBe("127.0.0.1");
});

test("a client connects with the split values, and the server needs no password", async () => {
	const split = await env(shop, "backend/.env");
	expect(split.DB_HOST).toBe("127.0.0.1");
	expect(split.DB_DATABASE).toBe("pg_shop_db");
	expect(split.DB_USERNAME).toBe("postgres");
	const out = await box.psql(
		[
			"-h",
			split.DB_HOST as string,
			"-p",
			split.DB_PORT as string,
			"-U",
			split.DB_USERNAME as string,
			"-d",
			split.DB_DATABASE as string,
			"-w",
		],
		"select current_user, current_database()",
	);
	expect(out.stderr).toBe("");
	expect(out.stdout.trim()).toBe("postgres|pg_shop_db");
});

test("pgvector and Postgres's standard extensions can be created; basepad enables none", async () => {
	expect(await sql(shop, "select count(*) from pg_extension where extname <> 'plpgsql'")).toBe("0");
	await sql(shop, "create extension vector; create extension pg_trgm; create extension citext");
	expect(await sql(shop, "select '[1,2]'::vector <-> '[1,5]'::vector")).toBe("3");
});

test("status lists the service with its state and address", async () => {
	const out = await box.basepad(shop, "status");
	const { DB_PORT } = await env(shop, "backend/.env");
	expect(out.code).toBe(0);
	expect(out.stdout).toMatch(
		new RegExp(`^db +postgresql://postgres@127\\.0\\.0\\.1:${DB_PORT}/pg_shop_db +running$`, "m"),
	);
});

test("rows written before down are there after up, and down stops the server", async () => {
	await sql(shop, "create table notes (body text); insert into notes values ('kept')");
	const down = await box.basepad(shop, "down");
	expect(down.code).toBe(0);
	const url = (await env(shop, ".env.local")).DATABASE_URL as string;
	expect((await box.psql([url], "select 1")).code).not.toBe(0);
	expect((await box.basepad(shop, "status")).stdout).toMatch(/^db +\S+ +stopped$/m);
	const up = await box.basepad(shop, "up");
	expect(up.stderr).toBe("");
	expect(await sql(shop, "select body from notes")).toBe("kept");
});

test("down stops the server promptly while a client is connected", async () => {
	const url = (await env(shop, ".env.local")).DATABASE_URL as string;
	const client = box.psql([url], "select pg_sleep(60)");
	await new Promise((resolve) => setTimeout(resolve, 1000));
	const started = Date.now();
	expect((await box.basepad(shop, "down")).code).toBe(0);
	expect(Date.now() - started).toBeLessThan(5000);
	expect((await client).code).not.toBe(0);
	expect((await box.basepad(shop, "up")).code).toBe(0);
});

test("a second checkout under the same name is refused, naming the owner and --claim", async () => {
	const copy = await box.project("copy", { "basepad.config.ts": config });
	const out = await box.basepad(copy, "up");
	expect(out.code).not.toBe(0);
	expect(out.stderr).toContain(shop);
	expect(out.stderr).toContain("basepad up --claim");
	expect(await sql(shop, "select body from notes")).toBe("kept");
});

test("the database carries its owner checkout's path", async () => {
	expect(
		await sql(
			shop,
			"select shobj_description(oid, 'pg_database') from pg_database where datname = current_database()",
		),
	).toBe(shop);
});

const OWNER =
	"select shobj_description(oid, 'pg_database') from pg_database where datname = current_database()";

test("a database stamped by another folder is refused; --claim re-stamps it", async () => {
	await sql(shop, "comment on database pg_shop_db is '/elsewhere/shop'");
	const out = await box.basepad(shop, "up");
	expect(out.code).not.toBe(0);
	expect(out.stderr).toContain("/elsewhere/shop");
	expect(out.stderr).toContain("basepad up --claim");
	expect((await box.basepad(shop, "up", "--claim")).code).toBe(0);
	expect(await sql(shop, OWNER)).toBe(shop);
});

test("an unstamped database is stamped by up", async () => {
	await sql(shop, "comment on database pg_shop_db is null");
	const out = await box.basepad(shop, "up");
	expect(out.stderr).toBe("");
	expect(await sql(shop, OWNER)).toBe(shop);
});

test("up --claim makes the second checkout the owner, and the first is then refused", async () => {
	const copy = await box.project("claimer", { "basepad.config.ts": config });
	const claimed = await box.basepad(copy, "up", "--claim");
	expect(claimed.stderr).toBe("");
	expect(claimed.code).toBe(0);
	expect(await sql(copy, "select body from notes")).toBe("kept");
	const again = await box.basepad(copy, "up");
	expect(again.code).toBe(0);
	const first = await box.basepad(shop, "up");
	expect(first.code).not.toBe(0);
	expect(first.stderr).toContain(copy);
	expect((await box.basepad(shop, "up", "--claim")).code).toBe(0);
});

test("when the port is taken, the next free one is used and the env files follow", async () => {
	const before = Number((await env(shop, "backend/.env")).DB_PORT);
	await box.basepad(shop, "down");
	const squatter: Server = createServer();
	await new Promise<void>((resolve) => squatter.listen(before, "127.0.0.1", resolve));
	try {
		const up = await box.basepad(shop, "up");
		expect(up.stderr).toBe("");
		const after = Number((await env(shop, "backend/.env")).DB_PORT);
		expect(after).not.toBe(before);
		expect((await env(shop, ".env.local")).DATABASE_URL).toContain(`:${after}/`);
		expect(await sql(shop, "select body from notes")).toBe("kept");
	} finally {
		await new Promise((resolve) => squatter.close(resolve));
	}
});
