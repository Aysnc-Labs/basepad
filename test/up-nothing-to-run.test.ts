import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box.dispose());

test("up in a project with nothing to run registers it, and again on a second up", async () => {
	const dir = await box.project("b40bare", {
		"basepad.config.ts": configFile(`{ name: "b40bare" }`),
	});
	for (const attempt of [1, 2]) {
		const out = await box.basepad(dir, "up");
		expect({ attempt, stderr: out.stderr, code: out.code }).toEqual({
			attempt,
			stderr: "",
			code: 0,
		});
	}
	expect((await box.basepad(dir, "down")).code).toBe(0);
}, 120_000);
