import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box.dispose());

test("on a Node older than 24, basepad runs again on mise's Node 24", {
	timeout: 300_000,
}, async () => {
	const dir = await box.project("old-node", {
		"package.json": '{ "type": "commonjs" }',
		"basepad.config.ts": configFile(`{ name: "shop", apps: { web: { run: "next dev" } } }`),
	});
	const out = await box.basepadWith(
		{ via: ["mise", "exec", "node@18", "--", "node"] },
		dir,
		"status",
	);
	expect(out.stdout).toContain("web  https://web.shop.localhost  stopped");
	expect(out.code).toBe(0);
});
