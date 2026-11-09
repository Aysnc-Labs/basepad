import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

function blockOf(envFile: string): Record<string, string> {
	const match = envFile.match(/# >>> basepad[^\n]*\n([\s\S]*?)# <<< basepad\n/);
	if (!match?.[1]) throw new Error(`no basepad block in:\n${envFile}`);
	return Object.fromEntries(
		match[1]
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

// CI sets this when it can't download Neon's proxy (a private release), and says so in a warning.
describe.skipIf(process.env.BASEPAD_TEST_SKIP_NEON_PROXY === "1")(
	"basepad add postgres-neon",
	() => {
		test("Neon's serverless driver runs a transaction on each project's database, through one proxy", async () => {
			const shop = await box.project("shop", { ".env.local": "SECRET_KEY=keep-me\n" });
			const cafe = await box.project("cafe");

			for (const dir of [shop, cafe]) {
				const add = await box.basepad(dir, "add", "postgres-neon");
				expect(add.stderr).toBe("");
				expect(add.code).toBe(0);
			}

			const shopEnv = await readFile(join(shop, ".env.local"), "utf8");
			expect(shopEnv.startsWith("SECRET_KEY=keep-me\n")).toBe(true);
			const shopVars = blockOf(shopEnv);
			const cafeVars = blockOf(await readFile(join(cafe, ".env.local"), "utf8"));
			expect(Object.keys(shopVars).sort()).toEqual(["DATABASE_URL", "NEON_WS_PROXY"]);
			expect(shopVars.DATABASE_URL).toMatch(
				/^postgres:\/\/postgres:[^@]+@localhost:\d+\/shop\?options=endpoint%3Dlocal$/,
			);
			expect(shopVars.NEON_WS_PROXY).toMatch(/^localhost:\d+\/v2$/);
			expect(cafeVars.NEON_WS_PROXY).toBe(shopVars.NEON_WS_PROXY);

			const shopRun = await box.node("neon-app.mjs", join(shop, ".env.local"), "orders", "tea");
			expect(shopRun.stderr).toBe("");
			expect(JSON.parse(shopRun.stdout)).toEqual([{ db: "shop", name: "tea" }]);
			const cafeRun = await box.node("neon-app.mjs", join(cafe, ".env.local"), "tables", "four");
			expect(cafeRun.stderr).toBe("");
			expect(JSON.parse(cafeRun.stdout)).toEqual([{ db: "cafe", name: "four" }]);

			// Each transaction committed to its own project's database, and only there.
			const plain = (url: string) => url.replace(/\?.*$/, "");
			const shopUrl = plain(shopVars.DATABASE_URL as string);
			const cafeUrl = plain(cafeVars.DATABASE_URL as string);
			expect((await box.psql(shopUrl, "select name from orders")).stdout.trim()).toBe("tea");
			expect((await box.psql(cafeUrl, "select name from tables")).stdout.trim()).toBe("four");
			expect((await box.psql(cafeUrl, "select to_regclass('orders')")).stdout.trim()).toBe("");
		});

		test("references the shared Postgres and proxy, and status shows both", async () => {
			const deli = await box.project("deli");
			expect((await box.basepad(deli, "add", "postgres-neon")).code).toBe(0);

			const conf = await readFile(join(deli, ".config/mise/conf.d/basepad.toml"), "utf8");
			expect(conf).toContain("[daemons.postgres-neon]");
			expect(conf).toContain("[daemons.neon-proxy]");
			expect(conf).toContain('name = "neon-proxy"');

			const ls = await box.mise(deli, "daemons", "ls", "--json");
			const daemons = JSON.parse(ls.stdout) as { id: string; status: string; proxy: string }[];
			expect(daemons).toContainEqual(
				expect.objectContaining({ id: "basepad/neon-proxy", status: "running", proxy: "off" }),
			);

			const status = await box.basepad(deli, "status");
			expect(status.code).toBe(0);
			expect(status.stdout).toMatch(
				/^postgres-neon +running +\d+ +postgres:\/\/postgres:\*+@localhost:\d+\/deli\?options=endpoint%3Dlocal +-$/m,
			);
			expect(status.stdout).toMatch(/^neon-proxy +running +\d+ +ws:\/\/localhost:\d+\/v2 +-$/m);
		});
	},
);
