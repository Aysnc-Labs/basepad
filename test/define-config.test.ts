import { expect, test } from "vitest";
import { defineConfig, postgres } from "../src/index.ts";

test("postgres() defaults to version 18", () => {
	expect(postgres()).toEqual({ kind: "postgres", version: 18 });
	expect(postgres({ version: 17 })).toEqual({ kind: "postgres", version: 17 });
});

// `tsc --noEmit` checks the rest: `env` is typed by the config's own services and apps.
test("defineConfig types env's outputs from the config's services and apps", () => {
	const config = defineConfig({
		name: "shop",
		services: { db: postgres() },
		apps: { web: { run: "next dev" }, cms: { run: "npm run dev", cwd: "apps/cms" } },
		env: ({ db, cms }) => ({
			".env.local": { DATABASE_URL: db.url, DB_PORT: db.port, CMS_URL: cms.url },
			// @ts-expect-error: an app gives no port
			"bad/.env": { PORT: cms.port },
		}),
	});
	defineConfig({
		name: "shop",
		apps: { web: { run: "next dev" } },
		// @ts-expect-error: no service or app is named `db`
		env: ({ db }) => ({ ".env": { DATABASE_URL: db.url } }),
	});
	// @ts-expect-error: Postgres 16 is not offered
	postgres({ version: 16 });
	expect(config.name).toBe("shop");
});
