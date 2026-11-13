import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

/** A source with nothing in it (an empty file, a failed download) never replaces the database. */

let box: Sandbox;
let main: string;

const items = async () => {
	const url = (await readEnv(main, ".env.local")).DATABASE_URL as string;
	return (await box.psql([url], "select string_agg(name, ',') from items")).stdout.trim();
};

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t35empty", {
		"basepad.config.ts": configFile(`{
	name: "t35empty",
	services: { db: postgres() },
	env: ({ db }) => ({ ".env.local": { DATABASE_URL: db.url } }),
}`),
	});
	expect((await box.basepad(main, "up", "-d")).code).toBe(0);
	const url = (await readEnv(main, ".env.local")).DATABASE_URL as string;
	await box.psql([url], "create table items (name text); insert into items values ('keep')");
}, 300_000);
afterAll(() => box?.dispose());

test("db import of an empty file is refused, and the data stays", async () => {
	const empty = join(box.root, "empty.sql");
	await writeFile(empty, "");
	const result = await box.basepad(main, "db", "import", empty, "--yes");
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/empty/i);
	expect(await items()).toBe("keep");
});

test("db import of a file with only whitespace is refused, and the data stays", async () => {
	const blank = join(box.root, "blank.sql");
	await writeFile(blank, "\n  \t\n");
	const result = await box.basepad(main, "db", "import", blank, "--yes");
	expect(result.code).toBe(1);
	expect(result.stderr).toMatch(/empty/i);
	expect(await items()).toBe("keep");
});
