import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box.dispose());

const twoApps = configFile(`{
	name: "shop",
	services: { db: postgres({ version: 18 }) },
	apps: {
		web: { run: "next dev" },
		cms: { run: "npm run dev", cwd: "apps/cms" },
	},
	env: ({ db, cms }) => ({ ".env.local": { DATABASE_URL: db.url, CMS_URL: cms.url } }),
}`);

test("before any up, status lists each app at its domain, stopped", async () => {
	const dir = await box.project("shop", { "basepad.config.ts": twoApps });
	const out = await box.basepad(dir, "status");
	const port = `:${box.proxyPort}`;
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(out.stdout).toBe(
		[
			`APP  URL${" ".repeat(25 + port.length)}STATE`,
			`web  https://web.shop.localhost${port}  stopped`,
			`cms  https://cms.shop.localhost${port}  stopped`,
			"",
		].join("\n"),
	);
});
