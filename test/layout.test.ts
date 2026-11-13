import { expect, test } from "vitest";
import { postgres } from "../src/index.ts";
import { layout } from "../src/layout.ts";

const app = { run: "next dev", cwd: "/p" };

function project(name: string, apps: string[] = [], services: string[] = []) {
	return {
		file: "/p/basepad.config.ts",
		name,
		apps: Object.fromEntries(apps.map((key) => [key, app])),
		services: Object.fromEntries(services.map((key) => [key, postgres()])),
	};
}

test("each app is served at https://<app>.<name>.localhost", () => {
	const { apps } = layout(project("shop", ["web", "cms"]));
	expect(apps).toEqual({
		web: { host: "web.shop.localhost", url: "https://web.shop.localhost" },
		cms: { host: "cms.shop.localhost", url: "https://cms.shop.localhost" },
	});
});

test("a service's database is <name>_<service>, hyphens turned to underscores", () => {
	const { services } = layout(project("my-shop", [], ["db", "read-model"]));
	expect(services).toEqual({
		db: { database: "my_shop_db" },
		"read-model": { database: "my_shop_read_model" },
	});
});

test("a database name of exactly 63 bytes is kept whole", () => {
	const name = "a".repeat(60);
	expect(layout(project(name, [], ["db"])).services.db?.database).toBe(`${name}_db`);
});

test("a name that makes a database name over 63 bytes is rejected with the reason", () => {
	const name = "a".repeat(61);
	expect(() => layout(project(name, [], ["db"]))).toThrow(
		`/p/basepad.config.ts: \`name\` and service \`db\` make the database name "${name}_db", which is 64 bytes; Postgres allows 63. Shorten \`name\` or the service key.`,
	);
});

test("a name over 63 characters is rejected as a domain label", () => {
	const name = "a".repeat(64);
	expect(() => layout(project(name, ["web"]))).toThrow(
		"/p/basepad.config.ts: `name` is 64 characters; a domain label allows 63.",
	);
});

test("an app key over 63 characters is rejected as a domain label", () => {
	const key = "w".repeat(64);
	expect(() => layout(project("shop", [key]))).toThrow(
		`/p/basepad.config.ts: app \`${key}\` is 64 characters; a domain label allows 63.`,
	);
});
