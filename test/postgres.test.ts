import { readFile } from "node:fs/promises";
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

test("up runs the project's Postgres, and a client connects with the written URL", async () => {
	expect(firstUp.stderr).toBe("");
	expect(firstUp.code).toBe(0);
	expect(await sql(shop, "select current_database()")).toBe("pg_shop_db");
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
