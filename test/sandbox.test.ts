import { afterAll, beforeAll, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});

test("a program killed by a signal reports it, not exit 1 with no output", async () => {
	const out = await box.run("sh", ["-c", "kill -TERM $$"]);
	expect(out.code).toBe(143);
	expect(out.stderr).toContain("killed by SIGTERM");
});
