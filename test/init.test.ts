import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box.dispose());

const read = (dir: string, file: string) => readFile(join(dir, file), "utf8");
const { version } = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

test("init writes a starter config named from the folder, which status loads", async () => {
	const dir = await box.project("My_Shop");
	const out = await box.basepad(dir, "init");
	expect(out.code).toBe(0);
	expect(await read(dir, "basepad.config.ts")).toContain('name: "my-shop",');
	expect(await read(dir, ".gitignore")).toBe("basepad.config.local.ts\n");

	const status = await box.basepad(dir, "status");
	expect(status.stderr).toBe("");
	expect(status.code).toBe(0);
});

test("init adds the local file to an existing .gitignore once", async () => {
	const dir = await box.project("ignored", { ".gitignore": "node_modules" });
	await box.basepad(dir, "init");
	expect(await read(dir, ".gitignore")).toBe("node_modules\nbasepad.config.local.ts\n");

	const again = await box.project("ignored-already", {
		".gitignore": "/basepad.config.local.ts\n",
	});
	await box.basepad(again, "init");
	expect(await read(again, ".gitignore")).toBe("/basepad.config.local.ts\n");
});

test("init adds basepad as a devDependency when package.json lacks it", async () => {
	const dir = await box.project("pkg", {
		"package.json": '{\n  "name": "pkg",\n  "devDependencies": { "typescript": "^7.0.0" }\n}\n',
	});
	await box.basepad(dir, "init");
	expect(JSON.parse(await read(dir, "package.json"))).toEqual({
		name: "pkg",
		devDependencies: { typescript: "^7.0.0", basepad: `^${version}` },
	});
	expect(await read(dir, "package.json")).toMatch(/^\{\n {2}"name"/);
});

test("init leaves a package.json that already has basepad as it is", async () => {
	const text = '{"dependencies":{"basepad":"^0.0.0"}}';
	const dir = await box.project("has-it", { "package.json": text });
	await box.basepad(dir, "init");
	expect(await read(dir, "package.json")).toBe(text);
});

test("init refuses to overwrite an existing config, and changes nothing", async () => {
	const dir = await box.project("taken", { "basepad.config.ts": "// mine\n" });
	const out = await box.basepad(dir, "init");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		`basepad: ${join(dir, "basepad.config.ts")} already exists; \`basepad init\` leaves it as it is.\n`,
	);
	expect(await read(dir, "basepad.config.ts")).toBe("// mine\n");
	await expect(read(dir, ".gitignore")).rejects.toThrow();
});
