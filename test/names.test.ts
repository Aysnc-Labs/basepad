import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
let main: string;

beforeAll(async () => {
	box = await sandbox();
	const app = join(import.meta.dirname, "name-app.mjs");
	main = await box.repo("shop", {
		"basepad.toml": [
			"[app]",
			`run = "exec '${process.execPath}' '${app}'"`,
			"",
			"[services.mailpit]",
			"",
		].join("\n"),
		".gitignore": [".env.local", ".config/mise/conf.d/", "pitchfork.local.toml", ""].join("\n"),
	});
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	expect(up.code).toBe(0);
	for (const name of ["feat/x", "pr-42"]) {
		const add = await box.basepad(main, "worktree", "add", name);
		expect(add.stderr).toBe("");
		expect(add.code).toBe(0);
	}
});
afterAll(async () => {
	await box?.dispose();
});

const checkout = (name: string) => join(dirname(main), `${basename(main)}-${name}`);
const named = (host: string) => `http://${host}:${box.proxyPort}`;

/** The rows of `basepad status`, keyed by service, as a developer reads them. */
async function status(dir: string): Promise<Record<string, { url: string; name: string }>> {
	const out = await box.basepad(dir, "status");
	expect(out.code).toBe(0);
	const [header, ...lines] = out.stdout.trim().split("\n");
	expect(header?.split(/\s+/)).toEqual(["SERVICE", "STATE", "PORT", "URL", "NAME"]);
	return Object.fromEntries(
		lines.map((line) => {
			const [service, , , url, name] = line.split(/\s+/);
			return [service, { url, name }];
		}),
	);
}

async function body(url: string): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
	expect(res.status, url).toBe(200);
	return (await res.text()).trim();
}

/** Opens a websocket, as a dev server's hot-reload client does, and returns the echo of `ping`. */
function echo(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timer = setTimeout(() => reject(new Error(`${url}: no echo`)), 5000);
		socket.onopen = () => socket.send("ping");
		socket.onmessage = (event) => {
			clearTimeout(timer);
			socket.close();
			resolve(String(event.data));
		};
		socket.onerror = () => reject(new Error(`${url}: websocket failed`));
	});
}

test("each checkout's app answers at its own name, beside its raw port", async () => {
	const checkouts = [
		{ dir: main, host: "app.shop.localhost" },
		{ dir: checkout("feat-x"), host: "app.feat-x.shop.localhost" },
		{ dir: checkout("pr-42"), host: "app.pr-42.shop.localhost" },
	];
	for (const { dir, host } of checkouts) {
		const app = (await status(dir)).app;
		expect(app?.name).toBe(named(host));
		expect(app?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await body(app?.name as string)).toBe(basename(dir));
		expect(await body(app?.url as string)).toBe(basename(dir));
	}
});

test("the inbox answers at its name in every checkout", async () => {
	for (const dir of [main, checkout("pr-42")]) {
		const inbox = (await status(dir))["mailpit/inbox"];
		expect(inbox?.name).toBe(named("mail.basepad.localhost"));
		expect(inbox?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await body(`${inbox?.name}/readyz`)).toBe("");
	}
});

test("hot-reload websockets connect through each name to that checkout's server", async () => {
	expect(await echo(`ws://app.shop.localhost:${box.proxyPort}/ws`)).toBe("shop: ping");
	expect(await echo(`ws://app.feat-x.shop.localhost:${box.proxyPort}/ws`)).toBe(
		"shop-feat-x: ping",
	);
	expect(await echo(`ws://app.pr-42.shop.localhost:${box.proxyPort}/ws`)).toBe("shop-pr-42: ping");
});

test("a worktree whose name folds to another's label gets a name of its own", async () => {
	const add = await box.basepad(main, "worktree", "add", "feat-x", "--path", checkout("feat-x2"));
	expect(add.code).toBe(0);
	const app = (await status(checkout("feat-x2"))).app;
	expect(app?.name).toBe(named("app.feat-x-2.shop.localhost"));
	expect(await body(app?.name as string)).toBe("shop-feat-x2");
	expect(await body(named("app.feat-x.shop.localhost"))).toBe("shop-feat-x");
});

test("worktree remove takes its name down and leaves the others", async () => {
	const before = (await status(checkout("pr-42"))).app?.url as string;
	const remove = await box.basepad(main, "worktree", "remove", "pr-42");
	expect(remove.code).toBe(0);
	await expect(fetch(before, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
	const gone = await fetch(named("app.pr-42.shop.localhost"), {
		signal: AbortSignal.timeout(5000),
	}).catch(() => undefined);
	expect(gone?.status ?? 0).not.toBe(200);
	expect(await body(named("app.feat-x.shop.localhost"))).toBe("shop-feat-x");
	expect(await body(named("app.shop.localhost"))).toBe("shop");
});

test("the app's daemon leaves the app's own APP_URL and APP_PORT alone", async () => {
	const env = await box.mise(main, "env", "--json");
	expect(env.code).toBe(0);
	const vars = JSON.parse(env.stdout) as Record<string, string>;
	expect(vars).not.toHaveProperty("APP_URL");
	expect(vars).not.toHaveProperty("APP_PORT");
});
