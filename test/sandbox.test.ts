import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
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

test("a sandbox project gets the test mise.toml, trusted, with its tools already installed", async () => {
	const dir = await box.project("tools");
	expect(await readFile(join(dir, "mise.toml"), "utf8")).toBe(
		await readFile(join(import.meta.dirname, "project-mise.toml"), "utf8"),
	);
	const mailpit = await box.run("mise", ["-C", dir, "which", "mailpit"]);
	expect(mailpit.stderr).toBe("");
	expect(mailpit.stdout.trim()).toBe(
		join(inject("miseDataDir"), "installs/mailpit/1.33.1/mailpit"),
	);
});
