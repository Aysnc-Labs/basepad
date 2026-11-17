import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("versions.ts imports nothing, so the launcher reads it on any Node", async () => {
	const source = await readFile(join(import.meta.dirname, "../src/versions.ts"), "utf8");
	expect(source).not.toMatch(/\bimport\b|\bfrom\s+["'`]|\brequire\s*\(/);
});
