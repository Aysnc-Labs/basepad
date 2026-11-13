import { expect, test } from "vitest";
import { postgres } from "../src/index.ts";
import { layout, machine } from "../src/layout.ts";

const app = { run: "next dev", cwd: "/p" };
const here = { home: "/h", proxyPort: 7443 };

function project(name: string, apps: string[] = [], services: string[] = []) {
	return {
		file: "/p/basepad.config.ts",
		name,
		apps: Object.fromEntries(apps.map((key) => [key, app])),
		services: Object.fromEntries(services.map((key) => [key, postgres()])),
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
		layout(project("shop", [], ["db"]), { home: "/x", proxyPort: 1 }).services.db?.port,
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
	const name = "a".repeat(60);
	expect(layout(project(name, [], ["db"]), here).services.db?.database).toBe(`${name}_db`);
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

test("on the standard HTTPS port an app's URL carries no port", () => {
	const { apps } = layout(project("shop", ["web"]), { ...here, proxyPort: 443 });
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
	expect(machine({ BASEPAD_HOME: "/x", BASEPAD_PROXY_PORT: "9443" })).toEqual({
		home: "/x",
		proxyPort: 9443,
	});
	expect(machine({ HOME: "/u" })).toEqual({ home: "/u/.basepad", proxyPort: 7443 });
	expect(() => machine({ BASEPAD_PROXY_PORT: "nope" })).toThrow(
		"BASEPAD_PROXY_PORT must be a port number; got `nope`.",
	);
});
