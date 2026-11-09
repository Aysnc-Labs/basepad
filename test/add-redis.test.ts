import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { blockOf, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

test("basepad add redis gives each project its own Redis, and a named one its own variable", async () => {
	const shop = await box.project("shop");
	const cafe = await box.project("cafe");
	for (const dir of [shop, cafe]) {
		const add = await box.basepad(dir, "add", "redis");
		expect(add.stderr).toBe("");
		expect(add.code).toBe(0);
	}
	const named = await box.basepad(shop, "add", "redis", "--name", "cache");
	expect(named.stderr).toBe("");
	expect(named.code).toBe(0);

	const shopVars = blockOf(await readFile(join(shop, ".env.local"), "utf8"));
	const cafeVars = blockOf(await readFile(join(cafe, ".env.local"), "utf8"));
	expect(Object.keys(shopVars)).toEqual(["REDIS_URL", "CACHE_URL"]);
	const urls = [shopVars.REDIS_URL, shopVars.CACHE_URL, cafeVars.REDIS_URL] as string[];
	for (const url of urls) expect(url).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
	expect(new Set(urls).size).toBe(3);

	expect((await box.redis(urls[0] as string, "SET", "who", "shop")).stdout.trim()).toBe("OK");
	expect((await box.redis(urls[0] as string, "GET", "who")).stdout.trim()).toBe("shop");
	expect((await box.redis(urls[1] as string, "EXISTS", "who")).stdout.trim()).toBe("0");
	expect((await box.redis(urls[2] as string, "EXISTS", "who")).stdout.trim()).toBe("0");

	const conf = await readFile(join(cafe, ".config/mise/conf.d/basepad.toml"), "utf8");
	expect(conf).toContain("[daemons.redis]");
	expect(conf).not.toContain("project =");

	const status = await box.basepad(shop, "status");
	expect(status.stderr).toBe("");
	expect(status.stdout).toMatch(/^redis +running +\d+ +redis:\/\/127\.0\.0\.1:\d+$/m);
	expect(status.stdout).toMatch(/^cache +running +\d+ +redis:/m);
	expect(status.stdout.match(/^redis /gm)).toHaveLength(1);
});
