import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

// The privileged steps never run on a desktop: only `--dry-run` and the refusal without consent
// are exercised there. As root on Linux (the CI container) basepad needs no consent: the proxy
// takes port 443 itself (BASEPAD_PROXY_PORT unset), so only this file may run it there.
const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const env = rootOnLinux ? { BASEPAD_PROXY_PORT: "" } : {};
const port = () => (rootOnLinux ? 443 : box.proxyPort);
const suffix = () => (rootOnLinux ? "" : `:${box.proxyPort}`);

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
}, 60_000);
afterAll(() => box.dispose());

const basepad = (cwd: string, ...args: string[]) => box.basepadWith({ env }, cwd, ...args);

test.skipIf(rootOnLinux)(
	"setup --dry-run prints the plan, marks privileged steps, and changes nothing",
	async () => {
		const out = await basepad(box.root, "setup", "--dry-run");
		expect(out.stderr).toBe("");
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("basepad setup will:");
		expect(out.stdout).toMatch(/install the pitchfork CA at .*ca\.pem into the system trust store/);
		if (process.platform === "darwin") {
			expect(out.stdout).toContain(
				`[sudo] write /etc/pf.anchors/pitchfork redirecting port 443 to ${box.proxyPort}`,
			);
		} else {
			expect(out.stdout).toContain(`redirect loopback traffic for port 443 to ${box.proxyPort}`);
			expect(out.stdout).toMatch(/Chrome and Firefox/);
		}
		expect(out.stdout).toContain(`URLs carry :${box.proxyPort} until then`);
		expect(out.stdout).toContain("Dry run: nothing was changed.");
		for (const dir of ["pf-state", "pf-config", "pf-logs"]) {
			expect(existsSync(join(box.root, dir))).toBe(false);
		}
	},
);

test.skipIf(rootOnLinux)(
	"without a terminal to ask, setup changes nothing and says how to consent",
	async () => {
		const out = await basepad(box.root, "setup");
		expect(out.code).toBe(1);
		expect(out.stdout).toContain("basepad setup will:");
		expect(out.stderr).toContain(
			"Nothing was changed: there is no terminal to ask for consent. Run `basepad setup --yes` to apply the plan above.",
		);
	},
);

test.runIf(rootOnLinux)("as root on Linux, setup applies with no prompt", async () => {
	const out = await basepad(box.root, "setup");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(out.stdout).toContain("the proxy listens on port 443 itself");
	expect(out.stdout).toContain("URLs are port-free: https://<app>.<name>.localhost");
});

test("one app fetches another by its HTTPS domain from server-side code", async () => {
	const app = (script: string) =>
		JSON.stringify(`exec '${process.execPath}' '${join(import.meta.dirname, "apps", script)}'`);
	const dir = await box.project("pair", {
		"basepad.config.ts": configFile(`{
			name: "pair",
			apps: {
				web: { run: ${app("fetcher.mjs")} },
				api: { run: ${app("echo.mjs")}, cwd: "api" },
			},
			env: ({ api }) => ({ ".env": { API_URL: api.url } }),
		}`),
		"api/package.json": "{}\n",
	});
	const up = await basepad(dir, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	const api = `https://api.pair.localhost${suffix()}`;
	expect(up.stdout).toContain(`api  ${api}  running`);
	expect(up.stdout).toContain(`web  https://web.pair.localhost${suffix()}  running`);
	expect(await readFile(join(dir, ".env"), "utf8")).toBe(`API_URL=${api}\n`);

	const reply = await get(`https://web.pair.localhost${suffix()}`);
	expect(reply).toMatchObject({ url: api, status: 200, body: { cwd: join(dir, "api") } });

	const status = await basepad(dir, "status");
	expect(status.stdout).toContain(`web  https://web.pair.localhost${suffix()}  running`);
});

/** GETs a URL through basepad's proxy on 127.0.0.1, trusting only the sandbox's CA. */
async function get(url: string): Promise<unknown> {
	const { hostname } = new URL(url);
	const ca = await box.ca();
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port: port(), servername: hostname, headers: { host: hostname }, ca },
			(res) => {
				let body = "";
				res.setEncoding("utf8").on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => {
					try {
						resolve(JSON.parse(body));
					} catch {
						reject(
							new Error(
								`${url}: ${res.statusCode} ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}`,
							),
						);
					}
				});
			},
		);
		req.setTimeout(10_000, () => req.destroy(new Error(`${url}: timed out`)));
		req.on("error", reject);
		req.end();
	});
}
