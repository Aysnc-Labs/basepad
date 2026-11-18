import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeWhole } from "../src/internal/files.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function folder(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "basepad-files-"));
	dirs.push(dir);
	return dir;
}

test("while writeWhole writes, a reader sees the old file whole, then the new one", async () => {
	const file = join(await folder(), "x.json");
	await writeFile(file, '{"old":true}');
	const seen: string[] = [];
	await writeWhole(file, async (partial) => {
		await writeFile(partial, '{"new":');
		seen.push(await readFile(file, "utf8"));
		await writeFile(partial, '{"new":true}');
	});
	seen.push(await readFile(file, "utf8"));
	expect(seen).toEqual(['{"old":true}', '{"new":true}']);
});

test("a write that fails leaves the old file and no partial one", async () => {
	const dir = await folder();
	const file = join(dir, "x.json");
	await writeFile(file, "old");
	await expect(
		writeWhole(file, async (partial) => {
			await writeFile(partial, "half");
			throw new Error("disk full");
		}),
	).rejects.toThrow("disk full");
	expect(await readdir(dir)).toEqual(["x.json"]);
	expect(await readFile(file, "utf8")).toBe("old");
});
