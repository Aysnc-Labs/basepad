import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");

const config = (db: string) =>
	configFile(`{
	name: "neon-proxy-orphans",
	services: { ${db} },
	apps: { web: { run: ${JSON.stringify(`exec '${process.execPath}' '${echo}'`)} } },
	env: (outputs) => ({ ".env.local": { WEB_URL: outputs.web.url, ...("db" in outputs && "wsProxy" in outputs.db ? { NEON_WS_PROXY: outputs.db.wsProxy } : {}) } }),
}`);

let box: Sandbox;
let main: string;

const listening = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

async function upWithProxy(): Promise<number> {
	await writeFile(join(main, "basepad.config.ts"), config("db: postgresWithNeonProxy()"));
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	const port = Number(
		((await readEnv(main, ".env.local")).NEON_WS_PROXY as string).split(/[:/]/)[1],
	);
	expect(await listening(port)).toBe(true);
	return port;
}

async function proxyRunning(port: number): Promise<boolean> {
	const ps = await box.run("ps", ["-eo", "args"]);
	return ps.stdout.includes(`--wss 127.0.0.1:${port}`);
}

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("neon-proxy-orphans");
}, 300_000);
afterAll(() => box?.dispose());

test("up stops the proxy once the service is switched back to postgres()", async () => {
	const port = await upWithProxy();
	await writeFile(join(main, "basepad.config.ts"), config("db: postgres()"));
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect(up.stdout).not.toContain("db-neon-proxy");
	expect((await box.basepad(main, "status")).stdout).not.toContain("db-neon-proxy");
	expect(await listening(port)).toBe(false);
	expect(await proxyRunning(port)).toBe(false);
});

test("up stops the proxy once the service is removed", async () => {
	const port = await upWithProxy();
	await writeFile(join(main, "basepad.config.ts"), config(""));
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	expect((await box.basepad(main, "status")).stdout).not.toContain("db-neon-proxy");
	expect(await listening(port)).toBe(false);
	expect(await proxyRunning(port)).toBe(false);
});

test("prune stops a removed service's proxy with its data", async () => {
	const port = await upWithProxy();
	await writeFile(join(main, "basepad.config.ts"), config(""));
	const pruned = await box.onTerminal(main, "y\n", "prune");
	expect(pruned).toMatchObject({ code: 0, stdout: expect.stringContaining("Deleted") });
	expect(existsSync(join(box.root, "home/services/neon-proxy-orphans/db"))).toBe(false);
	expect(await listening(port)).toBe(false);
	expect(await proxyRunning(port)).toBe(false);
});
