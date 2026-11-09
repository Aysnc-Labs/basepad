import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockOf, daemonExports, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

const userEnv = "# my own settings\nSECRET_KEY=keep-me\n";

describe("basepad add postgres", () => {
	test("gives the project a database on the shared Postgres, in its env block", async () => {
		const shop = await box.project("shop", { ".env.local": userEnv });

		const add = await box.basepad(shop, "add", "postgres");
		expect(add.stderr).toBe("");
		expect(add.code).toBe(0);

		const envFile = await readFile(join(shop, ".env.local"), "utf8");
		expect(envFile.startsWith(userEnv)).toBe(true);
		const url = blockOf(envFile).DATABASE_URL;
		expect(url).toMatch(/^postgres:\/\/postgres:[^@]+@localhost:\d+\/shop$/);

		const select = await box.psql(url as string, "select current_database()");
		expect(select.stdout.trim()).toBe("shop");
	});

	test("is idempotent, and a named service gets its own database and variable", async () => {
		const cafe = await box.project("cafe", { ".env.local": userEnv });
		expect((await box.basepad(cafe, "add", "postgres")).code).toBe(0);
		const first = blockOf(await readFile(join(cafe, ".env.local"), "utf8"));

		expect((await box.basepad(cafe, "add", "postgres")).code).toBe(0);
		const add = await box.basepad(
			cafe,
			"add",
			"postgres",
			"--name",
			"analytics",
			"--preset",
			"next",
		);
		expect(add.stderr).toBe("");
		expect(add.code).toBe(0);

		const envFile = await readFile(join(cafe, ".env.local"), "utf8");
		expect(envFile.startsWith(userEnv)).toBe(true);
		expect(envFile.match(/# >>> basepad/g)).toHaveLength(1);
		const block = blockOf(envFile);
		expect(Object.keys(block).sort()).toEqual(["ANALYTICS_DATABASE_URL", "DATABASE_URL"]);
		expect(block.DATABASE_URL).toBe(first.DATABASE_URL);
		expect(block.ANALYTICS_DATABASE_URL).toMatch(/@localhost:\d+\/cafe_analytics$/);
		const select = await box.psql(
			block.ANALYTICS_DATABASE_URL as string,
			"select current_database()",
		);
		expect(select.stdout.trim()).toBe("cafe_analytics");
	});

	test("references the shared daemon from the project's conf.d, without mise's own variables", async () => {
		const deli = await box.project("deli");
		expect((await box.basepad(deli, "add", "postgres", "--name", "db")).code).toBe(0);

		const conf = await readFile(join(deli, ".config/mise/conf.d/basepad.toml"), "utf8");
		expect(conf).toContain("[daemons.db]");
		expect(conf).toContain(`project = ${JSON.stringify(box.home)}`);
		expect(conf).toContain('name = "postgres"');

		const ls = await box.mise(deli, "daemons", "ls", "--json");
		const daemons = JSON.parse(ls.stdout) as { id: string; status: string; proxy: string }[];
		expect(daemons).toContainEqual(
			expect.objectContaining({ id: "basepad/postgres", status: "running", proxy: "off" }),
		);

		expect(await daemonExports(box, deli)).toEqual([]);
	});

	test("rewrites a stale block in place, keeping the lines around it", async () => {
		const before = "FIRST=1\n\n# >>> basepad\nDATABASE_URL=postgres://old\n# <<< basepad\nLAST=2\n";
		const bar = await box.project("bar", { ".env.local": before });
		expect((await box.basepad(bar, "add", "postgres")).code).toBe(0);

		const envFile = await readFile(join(bar, ".env.local"), "utf8");
		expect(envFile.startsWith("FIRST=1\n\n# >>> basepad")).toBe(true);
		expect(envFile.endsWith("# <<< basepad\nLAST=2\n")).toBe(true);
		expect(blockOf(envFile).DATABASE_URL).toMatch(/@localhost:\d+\/bar$/);
	});

	test("two projects adding at once both get their database, and both remember it", async () => {
		const [one, two] = await Promise.all([box.project("one"), box.project("two")]);
		const results = await Promise.all([
			box.basepad(one, "add", "postgres"),
			box.basepad(two, "add", "postgres"),
		]);
		expect(results.map((r) => r.code)).toEqual([0, 0]);
		for (const [dir, db] of [
			[one, "one"],
			[two, "two"],
		] as const) {
			const url = blockOf(await readFile(join(dir, ".env.local"), "utf8")).DATABASE_URL as string;
			expect((await box.psql(url, "select current_database()")).stdout.trim()).toBe(db);
			expect((await box.basepad(dir, "status")).stdout).toMatch(
				new RegExp(`^postgres +running .*/${db} +-$`, "m"),
			);
		}
	});
});
