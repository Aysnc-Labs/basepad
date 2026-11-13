import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { request } from "node:https";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RESTART_WARNING } from "../src/supervisor.ts";
import { configFile, freePort, type Result, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const node = (script: string) => `exec '${process.execPath}' '${script}'`;

const ENV_LOCAL = "# my secrets\nSECRET=hunter2\nWEB_URL=http://stale\n\nTRAILING=1\n";

let box: Sandbox;
let shop: string;
let firstUp: Result;
/** Every file in the project but `node_modules`, with its bytes and mtime, before `up`. */
let before: Map<string, { text: string; mtime: number }>;

beforeAll(async () => {
	box = await sandbox();
	shop = await box.project("shop", {
		"basepad.config.ts": configFile(`{
			name: "shop",
			apps: {
				web: { run: ${JSON.stringify(node(echo))} },
				cms: { run: ${JSON.stringify(node(echo))}, cwd: "apps/cms" },
			},
			env: ({ web, cms }) => ({
				".env.local": { WEB_URL: web.url, CMS_URL: cms.url },
				"backend/.env": { APP_URL: web.url, GREETING: "hello world # not a comment" },
			}),
		}`),
		".env.local": ENV_LOCAL,
		"apps/cms/package.json": "{}\n",
		"backend/README": "no env file yet\n",
	});
	before = await files(shop);
	firstUp = await box.basepad(shop, "up");
}, 180_000);
afterAll(() => box?.dispose());

async function files(dir: string): Promise<Map<string, { text: string; mtime: number }>> {
	const out = new Map<string, { text: string; mtime: number }>();
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		if (!entry.isFile() || relative(dir, path).startsWith("node_modules")) continue;
		out.set(relative(dir, path), {
			text: await readFile(path, "utf8"),
			mtime: (await stat(path)).mtimeMs,
		});
	}
	return out;
}

type Echo = { cwd: string; port: number; pid: number };
const get = (url: string) => box.get<Echo>(url);

/** Opens a WebSocket through the proxy, as a hot-reload client does, and returns its first message. */
async function websocket(url: string): Promise<string> {
	const { hostname, port } = new URL(url);
	const ca = await box.ca();
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			servername: hostname,
			ca,
			headers: {
				host: `${hostname}:${port}`,
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": randomBytes(16).toString("base64"),
			},
		});
		req.setTimeout(5000, () => req.destroy(new Error(`${url}: timed out`)));
		req.on("upgrade", (_res, socket, head) => {
			const frame =
				head.length > 0
					? Promise.resolve(head)
					: new Promise<Buffer>((r) => socket.once("data", r));
			frame.then((bytes) => {
				socket.destroy();
				resolve(bytes.subarray(2, 2 + ((bytes[1] ?? 0) & 0x7f)).toString());
			});
		});
		req.on("response", (res) => reject(new Error(`${url}: no upgrade (${res.statusCode})`)));
		req.on("error", reject);
		req.end();
	});
}

const url = (app: string) => `https://${app}.shop.localhost:${box.proxyPort}`;

test("up starts each app, prints the table and returns", () => {
	expect(firstUp.stderr).toBe("");
	expect(firstUp.code).toBe(0);
	expect(firstUp.stdout).toContain(
		[
			`APP  URL${" ".repeat(url("web").length - 3)}  STATE`,
			`web  ${url("web")}  running`,
			`cms  ${url("cms")}  running`,
		].join("\n"),
	);
});

test("each app answers over HTTPS at its domain, from its folder, on its own PORT", async () => {
	const web = await get(url("web"));
	const cms = await get(url("cms"));
	expect(web.cwd).toBe(shop);
	expect(cms.cwd).toBe(join(shop, "apps/cms"));
	expect(web.port).toBeGreaterThan(0);
	expect(cms.port).not.toBe(web.port);
});

test("a WebSocket upgrade works through the domain", async () => {
	expect(await websocket(url("cms"))).toBe(`hello from ${join(shop, "apps/cms")}`);
});

test("up sets exactly the named keys and leaves every other line as it was", async () => {
	expect(await readFile(join(shop, ".env.local"), "utf8")).toBe(
		`# my secrets\nSECRET=hunter2\nWEB_URL=${url("web")}\n\nTRAILING=1\nCMS_URL=${url("cms")}\n`,
	);
	expect(await readFile(join(shop, "backend/.env"), "utf8")).toBe(
		`APP_URL=${url("web")}\nGREETING='hello world # not a comment'\n`,
	);
});

test("the project has no new or changed files but the named env files", async () => {
	const after = await files(shop);
	const changed = [...after.keys()].filter(
		(path) => before.get(path)?.text !== after.get(path)?.text,
	);
	expect(changed.sort()).toEqual([".env.local", "backend/.env"]);
});

test("a developer's own pitchfork is left alone", () => {
	for (const dir of ["pf-state", "pf-config", "pf-logs"]) {
		expect(existsSync(join(box.root, dir))).toBe(false);
	}
});

test("a second up changes no file and restarts nothing", async () => {
	const pid = (await get(url("web"))).pid;
	const envFiles = await files(shop);
	const again = await box.basepad(shop, "up", "-d");
	expect(again.stderr).toBe("");
	expect(again.code).toBe(0);
	expect(again.stdout).toContain(`web  ${url("web")}  running`);
	expect(await files(shop)).toEqual(envFiles);
	expect((await get(url("web"))).pid).toBe(pid);
});

test("status shows each app running with its URL", async () => {
	const out = await box.basepad(shop, "status");
	expect(out.code).toBe(0);
	expect(out.stdout).toContain(`web  ${url("web")}  running`);
	expect(out.stdout).toContain(`cms  ${url("cms")}  running`);
});

test("an app that exits on start is reported with its output, and up fails", async () => {
	const dir = await box.project("broken", {
		"basepad.config.ts": configFile(`{
			name: "broken",
			apps: {
				ok: { run: ${JSON.stringify(node(echo))} },
				bad: { run: ${JSON.stringify(node(join(import.meta.dirname, "apps/crash.mjs")))} },
			},
		}`),
	});
	const out = await box.basepad(dir, "up");
	expect(out.code).toBe(1);
	expect(out.stdout).toMatch(/bad +https:\/\/bad\.broken\.localhost:\d+ +failed/);
	expect(out.stdout).toMatch(/ok +https:\/\/ok\.broken\.localhost:\d+ +running/);
	expect(out.stderr).toContain("basepad: `bad` exited on start. Its last output:");
	expect(out.stderr).toContain("boom: DATABASE_URL is not set");
	expect(out.stderr).toMatch(/pitchfork logs broken\/bad/);
	await box.basepad(dir, "down");
});

test("up returns promptly while an app is slow to listen, and shows it starting", async () => {
	const dir = await box.project("slow", {
		"basepad.config.ts": configFile(`{
			name: "slow",
			apps: { lazy: { run: ${JSON.stringify(node(join(import.meta.dirname, "apps/slow.mjs")))} } },
		}`),
	});
	const started = Date.now();
	const out = await box.basepad(dir, "up");
	expect(Date.now() - started).toBeLessThan(20_000);
	expect(out.code).toBe(0);
	expect(out.stdout).toMatch(/lazy +https:\/\/lazy\.slow\.localhost:\d+ +starting/);
	await box.basepad(dir, "down");
});

test("down stops the project's apps and deletes nothing", async () => {
	const kept = await files(shop);
	const out = await box.basepad(shop, "down");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	await expect(get(url("web"))).rejects.toThrow();
	expect(await files(shop)).toEqual(kept);
	const status = await box.basepad(shop, "status");
	expect(status.stdout).toContain(`web  ${url("web")}  stopped`);
	expect(status.stdout).toContain(`cms  ${url("cms")}  stopped`);
});

test("up says so before a settings change restarts the supervisor, and only then", async () => {
	expect(firstUp.stdout).not.toContain(RESTART_WARNING);
	const other = String(await freePort());
	const out = await box.basepadWith({ env: { BASEPAD_PROXY_PORT: other } }, shop, "up");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(out.stdout.indexOf(RESTART_WARNING)).toBe(0);
	expect(out.stdout).toContain(`web  https://web.shop.localhost:${other}  running`);
	// Back on the sandbox's own port, so the supervisor is left as the file found it.
	expect((await box.basepad(shop, "down")).code).toBe(0);
}, 240_000); // Two restarts, and as root on Linux pitchfork's supervisor takes about 60 s to stop.
