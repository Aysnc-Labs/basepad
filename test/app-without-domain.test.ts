import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, type Sandbox, sandbox } from "./sandbox.ts";

/**
 * An app with `domain: false`, such as Vite behind another app's page: it serves HTTPS itself at
 * `https://localhost:$PORT`, with a certificate basepad gives it, and has no domain.
 */

const node = (script: string) =>
	JSON.stringify(`exec '${process.execPath}' '${join(import.meta.dirname, "apps", script)}'`);

let box: Sandbox;
let assets: string;
let up: Result;

beforeAll(async () => {
	box = await sandbox();
	assets = await box.project("assets", {
		"basepad.config.ts": configFile(`{
			name: "assets",
			apps: {
				web: { run: ${node("echo.mjs")} },
				vite: { run: ${node("tls.mjs")}, domain: false },
			},
			env: ({ web }) => ({ ".env": { APP_URL: web.url } }),
		}`),
	});
	up = await box.basepad(assets, "up");
}, 300_000);
afterAll(() => box?.dispose());

test("up runs it on its PORT with no domain, and shows it running with no URL", () => {
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect(up.stdout).toMatch(/^vite +running$/m);
	expect(up.stdout).not.toContain("vite.assets.localhost");
});

test("it serves HTTPS at localhost with basepad's certificate, which browsers trust after setup", async () => {
	const { port } = JSON.parse(await readFile(join(assets, "tls.json"), "utf8"));
	expect(await box.get(`https://localhost:${port}/`)).toEqual({ cwd: assets });
});
