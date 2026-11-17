import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { install } from "../src/tools.ts";

let root: string;
const before = { data: process.env.MISE_DATA_DIR, cache: process.env.MISE_CACHE_DIR };

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "basepad-tools-"));
	process.env.MISE_DATA_DIR = join(root, "data");
	process.env.MISE_CACHE_DIR = join(root, "cache");
});

afterAll(async () => {
	process.env.MISE_DATA_DIR = before.data;
	process.env.MISE_CACHE_DIR = before.cache;
	if (before.data === undefined) delete process.env.MISE_DATA_DIR;
	if (before.cache === undefined) delete process.env.MISE_CACHE_DIR;
	await rm(root, { recursive: true, force: true });
});

test("two installs of a tool at once, on a mise that has none, both get its programs", async () => {
	const home = join(root, "home");
	const [a, b] = await Promise.all([install("jq", "1.7.1", home), install("jq", "1.7.1", home)]);
	expect(existsSync(a.bin("jq"))).toBe(true);
	expect(b.bin("jq")).toBe(a.bin("jq"));
}, 120_000);
