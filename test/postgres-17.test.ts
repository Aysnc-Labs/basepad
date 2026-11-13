import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
let blog: string;

beforeAll(async () => {
	box = await sandbox();
	blog = await box.project("blog", {
		"basepad.config.ts": configFile(`{
			name: "pg-blog",
			services: { db: postgres({ version: 17 }) },
			env: ({ db }) => ({ ".env": { DATABASE_URL: db.url } }),
		}`),
	});
}, 60_000);
afterAll(() => box?.dispose());

async function sql(query: string) {
	const text = await readFile(join(blog, ".env"), "utf8");
	const url = /^DATABASE_URL=(.*)$/m.exec(text)?.[1] as string;
	return box.psql([url], query);
}

test("a project on Postgres 17 gets 17, and pgvector can be created", async () => {
	const up = await box.basepad(blog, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect((await sql("show server_version_num")).stdout).toMatch(/^17\d{4}\n$/);
	const vector = await sql("create extension vector; select '[3,4]'::vector <-> '[0,0]'::vector");
	expect(vector.stderr).toBe("");
	expect(vector.stdout).toContain("5");
}, 300_000);

// Reinstalling Postgres touches mise's installs, so it runs only where they are not a developer's own.
const ownInstalls = Boolean(process.env.CI || process.env.MISE_DATA_DIR);

test.runIf(ownInstalls)(
	"pgvector can still be created after Postgres is removed and reinstalled",
	async () => {
		expect((await box.basepad(blog, "down")).code).toBe(0);
		const mise = (...args: string[]) => box.run("mise", args);
		const where = (await mise("where", "postgres@17")).stdout.trim();
		expect((await mise("uninstall", "postgres@17")).code).toBe(0);
		expect((await mise("where", "postgres@17")).code).not.toBe(0);
		const up = await box.basepad(blog, "up");
		expect(up.stderr).toBe("");
		expect((await mise("where", "postgres@17")).stdout.trim()).toBe(where);
		const vector = await sql("drop extension vector; create extension vector");
		expect(vector.stderr).toBe("");
		expect(vector.code).toBe(0);
	},
	300_000,
);
