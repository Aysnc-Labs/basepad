import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

/** A source that creates nothing (an empty file, a failed download) never replaces the database. */

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

// Each one has no statement in it: empty, blank, a BOM, comments, bare `;`, NUL bytes.
for (const [name, body] of [
	["empty.sql", ""],
	["blank.sql", "\n  \t\n"],
	["bom.sql", Buffer.from([0xef, 0xbb, 0xbf])], // an "empty" file saved as UTF-8 with BOM
	["bom-newline.sql", Buffer.from([0xef, 0xbb, 0xbf, 0x0a])],
	["comments.sql", "-- nothing here\n/* nor here */\n"],
	["semicolons.sql", ";\n;\n"],
	["nul.sql", Buffer.alloc(16)],
] as const) {
	test(`db import of ${name}, with no statement in it, is refused, and the data stays`, async () => {
		const file = join(box.root, name);
		await writeFile(file, body);
		const result = await box.basepad(main, "db", "import", file, "--yes");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Could not import the SQL file ${file}`);
		expect(result.stderr).toContain("It created nothing in the database.");
		expect(await items()).toBe("keep");
	});
}
