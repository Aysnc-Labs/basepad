import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box.dispose());

test("on a Node older than 24, basepad runs again on mise's Node 24 without trusting the project's mise config", {
	timeout: 300_000,
}, async () => {
	const dir = await box.project("old-node", {
		"package.json": '{ "type": "commonjs" }',
		"mise.toml": '[env]\nFROM_PROJECT = "1"\n',
		"basepad.config.ts": configFile(`{ name: "shop", apps: { web: { run: "next dev" } } }`),
	});
	await box.run("mise", ["install", "node@18"]);
	const where = await box.run("mise", ["where", "node@18"]);
	const node18 = join(where.stdout.trim(), "bin/node");

	const out = await box.basepadWith({ via: [node18], env: box.untrusted() }, dir, "status");

	expect(out.stdout).toContain(`web  https://web.shop.localhost:${box.proxyPort}  stopped`);
	expect(out.code).toBe(0);
	const trusted = join(box.env.MISE_STATE_DIR as string, "trusted-configs");
	expect(existsSync(trusted) ? await readdir(trusted) : []).toEqual([]);
});
