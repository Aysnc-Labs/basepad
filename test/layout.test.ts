import { expect, test } from "vitest";
import type { PostgresNames } from "../src/catalogue/postgres.ts";
import { mailpit, postgres, redis } from "../src/index.ts";
import {
	daemonId,
	type Layout,
	layout as layoutOf,
	machine,
	nextSuffix,
	ofDaemon,
	suffixOf,
	worktreeFolder,
} from "../src/layout.ts";

/** Layout, its services read as Postgres's, which every service here is unless a test says. */
const layout = (...args: Parameters<typeof layoutOf>) =>
	layoutOf(...args) as Layout & { services: Record<string, PostgresNames> };

const app = { run: "next dev", cwd: "/p" };
const here = { home: "/h", proxyPort: 7443, portFree: false };

function project(name: string, apps: string[] = [], services: string[] = [], prefix = "worktree") {
	return {
		file: "/p/basepad.config.ts",
		name,
		apps: Object.fromEntries(apps.map((key) => [key, app])),
		services: Object.fromEntries(services.map((key) => [key, postgres()])),
		worktrees: { prefix },
	};
}

test("each app is served at https://<app>.<name>.localhost", () => {
	const { apps } = layout(project("shop", ["web", "cms"]), here);
	expect(apps.web?.url).toBe("https://web.shop.localhost:7443");
	expect(apps.cms?.url).toBe("https://cms.shop.localhost:7443");
	expect(apps.cms?.host).toBe("cms.shop.localhost");
});

test("a service's database is <name>_<service>, hyphens turned to underscores", () => {
	const { services } = layout(project("my-shop", [], ["db", "read-model"]), here);
	expect(services.db?.database).toBe("my_shop_db");
	expect(services["read-model"]?.database).toBe("my_shop_read_model");
});

test("a service's port comes from the name and key alone, in [15000, 20000)", () => {
	const port = (name: string, key: string) =>
		layout(project(name, ["web"], [key]), here).services[key]?.port as number;
	expect(port("shop", "db")).toBe(
		layout(project("shop", [], ["db"]), { home: "/x", proxyPort: 1, portFree: true }).services.db
			?.port,
	);
	for (const [name, key] of [
		["shop", "db"],
		["blog", "db"],
		["shop", "cache"],
	] as const) {
		expect(port(name, key)).toBeGreaterThanOrEqual(15000);
		expect(port(name, key)).toBeLessThan(20000);
	}
	expect(port("shop", "db")).not.toBe(port("blog", "db"));
	expect(port("shop", "db")).not.toBe(port("shop", "cache"));
});

test("a service's data lives in the home, under the name and the key", () => {
	expect(layout(project("shop", [], ["db"]), here).services.db?.dir).toBe("/h/services/shop/db");
});

test("a database name of exactly 63 bytes is kept whole", () => {
	// Shared, so no worktree database needs room beside it.
	const name = "a".repeat(60);
	const shared = { ...project(name), services: { db: postgres({ worktree: "shared" }) } };
	expect(layout(shared, here).services.db?.database).toBe(`${name}_db`);
	const tree = `${"b".repeat(48)}_db`;
	expect(
		layout(project("b".repeat(48), [], ["db"]), here, "worktree-12").services.db?.database,
	).toBe(`${tree}_worktree_12`);
});

test("a name that makes a database name over 63 bytes is rejected with the reason", () => {
	const name = "a".repeat(61);
	expect(() => layout(project(name, [], ["db"]), here)).toThrow(
		`/p/basepad.config.ts: \`name\` and service \`db\` make the database name "${name}_db", which is 64 bytes; Postgres allows 63. Shorten \`name\` or the service key.`,
	);
});

test("a name over 63 characters is rejected as a domain label", () => {
	const name = "a".repeat(64);
	expect(() => layout(project(name, ["web"]), here)).toThrow(
		"/p/basepad.config.ts: `name` is 64 characters; a domain label allows 63.",
	);
});

test("an app key over 63 characters is rejected as a domain label", () => {
	const key = "w".repeat(64);
	expect(() => layout(project("shop", [key]), here)).toThrow(
		`/p/basepad.config.ts: app \`${key}\` is 64 characters; a domain label allows 63.`,
	);
});

test("once port 443 reaches the proxy, an app's URL carries no port", () => {
	const { apps } = layout(project("shop", ["web"]), { ...here, portFree: true });
	expect(apps.web?.url).toBe("https://web.shop.localhost");
});

test("each app starts from its own port, the same every time, below the ephemeral range", () => {
	const ports = (name: string) =>
		Object.values(layout(project(name, ["web", "cms", "api"]), here).apps).map((a) => a.port);
	const shop = ports("shop");
	expect(ports("shop")).toEqual(shop);
	expect(new Set(shop).size).toBe(3);
	expect(ports("blog")).not.toEqual(shop);
	for (const port of [...shop, ...ports("blog")]) {
		expect(port).toBeGreaterThanOrEqual(20000);
		expect(port).toBeLessThan(32768);
	}
});

test("the environment's supervisor definitions live in basepad's home", () => {
	expect(layout(project("shop"), here).definitions).toBe("/h/environments/shop.toml");
});

test("the machine is read from BASEPAD_HOME and BASEPAD_PROXY_PORT, with defaults", () => {
	expect(machine({ BASEPAD_HOME: "/x", BASEPAD_PROXY_PORT: "9443" }, false)).toEqual({
		home: "/x",
		proxyPort: 9443,
		portFree: false,
	});
	expect(machine({ HOME: "/u" }, false)).toEqual({
		home: "/u/.basepad",
		proxyPort: 7443,
		portFree: false,
	});
	expect(() => machine({ BASEPAD_PROXY_PORT: "nope" })).toThrow(
		"BASEPAD_PROXY_PORT must be a port number; got `nope`.",
	);
});

test("as root on Linux the proxy listens on 443 itself, so URLs are port-free", () => {
	expect(machine({ HOME: "/root" }, true)).toEqual({
		home: "/root/.basepad",
		proxyPort: 443,
		portFree: true,
	});
	expect(machine({ HOME: "/root", BASEPAD_PROXY_PORT: "9443" }, true)).toMatchObject({
		proxyPort: 9443,
		portFree: false,
	});
});

test("a worktree's apps are at https://<app>.<suffix>.<name>.localhost", () => {
	const { apps } = layout(project("shop", ["web"]), here, "worktree-1");
	expect(apps.web?.host).toBe("web.worktree-1.shop.localhost");
	expect(apps.web?.url).toBe("https://web.worktree-1.shop.localhost:7443");
});

test("a worktree's database is <name>_<service>_<suffix>, on main's server", () => {
	const main = layout(project("my-shop", [], ["db"]), here).services.db;
	const tree = layout(project("my-shop", [], ["db"]), here, "worktree-12").services.db;
	expect(tree?.database).toBe("my_shop_db_worktree_12");
	expect(tree?.main).toBe("my_shop_db");
	expect(tree?.port).toBe(main?.port);
	expect(tree?.data).toBe(main?.data);
});

test("a shared service's worktree database is main's", () => {
	const shared = { ...project("shop"), services: { db: postgres({ worktree: "shared" }) } };
	expect(layout(shared, here, "worktree-1").services.db?.database).toBe("shop_db");
});

test("a worktree registers under its own namespace and definitions file", () => {
	const main = layout(project("shop"), here);
	const tree = layout(project("shop"), here, "worktree-1");
	expect(main.namespace).toBe("shop");
	expect(tree.namespace).toBe("shop.worktree-1");
	expect(tree.definitions).toBe("/h/environments/shop.worktree-1.toml");
});

test("every service runs in main's namespace, as <name>/<key>, in main and in a worktree", () => {
	for (const suffix of [undefined, "worktree-1"]) {
		const lay = layout(project("shop", [], ["db"]), here, suffix);
		expect(lay.mainNamespace).toBe("shop");
		expect(lay.services.db?.daemon).toBe("shop/db");
	}
});

test("a namespace of the project's worktree gives its suffix; any other gives none", () => {
	expect(suffixOf("shop", "shop.worktree-1")).toBe("worktree-1");
	expect(suffixOf("shop", "shop")).toBeUndefined();
	expect(suffixOf("shop", "shopping.worktree-1")).toBeUndefined();
	expect(suffixOf("shop", "blog.worktree-1")).toBeUndefined();
});

test("a daemon's id gives back its namespace and name, a worktree's too", () => {
	expect(ofDaemon("shop/web")).toEqual({ namespace: "shop", name: "web" });
	expect(ofDaemon("shop.worktree-1/web")).toEqual({ namespace: "shop.worktree-1", name: "web" });
	expect(ofDaemon(daemonId("shop.worktree-1", "db"))).toEqual({
		namespace: "shop.worktree-1",
		name: "db",
	});
});

test("a worktree's folder is <suffix> in <name>.worktrees beside the repository, or in worktrees.dir", () => {
	expect(worktreeFolder({ name: "shop", worktrees: {} }, "/code/shop")).toBe(
		"/code/shop.worktrees",
	);
	expect(worktreeFolder({ name: "shop", worktrees: {} }, "/code/shop", "worktree-2")).toBe(
		"/code/shop.worktrees/worktree-2",
	);
	expect(worktreeFolder({ name: "shop", worktrees: { dir: "/w" } }, "/code/shop", "wt-1")).toBe(
		"/w/wt-1",
	);
});

test("a name that leaves no room for a worktree's database is rejected at load, in main", () => {
	// 50 + "_db_worktree_999" is 66 bytes, though main's own 53 fit.
	const name = "a".repeat(50);
	expect(() => layout(project(name, [], ["db"]), here)).toThrow(
		`/p/basepad.config.ts: worktree suffixes like "worktree-999" leave too little room: service \`db\` makes a worktree's database name "${name}_db_worktree_999", which is 66 bytes; Postgres allows 63. Shorten \`name\`, the service key or \`worktrees.prefix\`.`,
	);
});

test("a prefix too long for a domain label is rejected at load", () => {
	const prefix = "p".repeat(60);
	expect(() => layout(project("shop", ["web"], [], prefix), here)).toThrow(
		`/p/basepad.config.ts: worktree suffixes like "${prefix}-999" leave too little room: the worktree suffix is 64 characters; a domain label allows 63. Shorten \`worktrees.prefix\`.`,
	);
});

test("a worktree takes the lowest free number for the prefix", () => {
	expect(nextSuffix("worktree", [])).toBe("worktree-1");
	expect(nextSuffix("worktree", ["worktree-1", "worktree-3", "main"])).toBe("worktree-2");
	expect(nextSuffix("wt", ["worktree-1", "wt-1", "wt-01"])).toBe("wt-2");
});

test("a worktree's own Redis runs in its namespace, on a port from its name; a shared one is main's", () => {
	const services = { cache: redis(), ref: redis({ worktree: "shared" }) };
	const main = layout({ ...project("shop"), services }, here).services;
	const tree = layout({ ...project("shop"), services }, here, "worktree-1").services;
	expect(main.cache?.daemon).toBe("shop/cache");
	expect(tree.cache?.daemon).toBe("shop.worktree-1/cache");
	expect(tree.cache?.port).not.toBe(main.cache?.port);
	expect(tree.ref?.daemon).toBe("shop/ref");
	expect(tree.ref?.port).toBe(main.ref?.port);
});

test("a service with a domain is served at <key>.<name>.localhost in main and every worktree, and an app of that key is refused", () => {
	const withMail = { ...project("shop", ["web"]), services: { mail: mailpit() } };
	expect(layout(withMail, here).services.mail?.web?.url).toBe("https://mail.shop.localhost:7443");
	expect(layout(withMail, here, "worktree-1").services.mail?.web?.host).toBe("mail.shop.localhost");
	expect(layout(project("shop", [], ["db"]), here).services.db?.web).toBeUndefined();
	const clash = { ...project("shop", ["mail"]), services: { mail: mailpit() } };
	expect(() => layout(clash, here)).toThrow(/mail\.shop\.localhost, which is app `mail`'s domain/);
});
