import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadProject } from "../src/config.ts";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box.dispose());

const twoApps = configFile(`{
	name: "shop",
	services: { db: postgres() },
	apps: {
		web: { run: "next dev" },
		cms: { run: "npm run dev", cwd: "apps/cms" },
	},
}`);

let n = 0;
const scratch = (files: Record<string, string>) => box.project(`p${++n}`, files);

describe("loads under every module type, with no warnings", () => {
	const cases: [string, Record<string, string>][] = [
		['"type": "commonjs"', { "package.json": '{ "type": "commonjs" }' }],
		['"type": "module"', { "package.json": '{ "type": "module" }' }],
		["no type", { "package.json": "{}" }],
		["no package.json", {}],
	];
	test.each(cases)("%s", async (_, files) => {
		const dir = await scratch({ ...files, "basepad.config.ts": twoApps });
		const out = await box.basepad(dir, "status");
		expect(out.stderr).toBe("");
		expect(out.stdout).toContain(`cms  https://cms.shop.localhost:${box.proxyPort}  stopped`);
		expect(out.code).toBe(0);
	});
});

test("gives one plain description, apps' folders resolved from the config", async () => {
	const dir = await scratch({ "basepad.config.ts": twoApps });
	const project = await loadProject(join(dir, "apps"));
	expect(project).toMatchObject({
		file: join(dir, "basepad.config.ts"),
		root: dir,
		name: "shop",
		services: { db: { kind: "postgres", version: 18 } },
		apps: {
			web: { run: "next dev", cwd: dir },
			cms: { run: "npm run dev", cwd: join(dir, "apps/cms") },
		},
	});
});

test("worktrees default to the prefix `worktree`; a set `dir` resolves from the config", async () => {
	const plain = await loadProject(await scratch({ "basepad.config.ts": twoApps }));
	expect(plain.worktrees).toEqual({ prefix: "worktree", clone: [], setup: [] });
	expect(plain.services.db).toMatchObject({ worktree: "copy" });
	const dir = await scratch({
		"basepad.config.ts": configFile(`{
			name: "shop",
			services: { db: postgres({ worktree: "empty" }) },
			worktrees: { prefix: "wt", dir: "../trees", clone: ["node_modules"], setup: ["npm ci"] },
		}`),
	});
	const project = await loadProject(dir);
	expect(project.worktrees).toEqual({
		prefix: "wt",
		dir: join(dir, "../trees"),
		clone: ["node_modules"],
		setup: ["npm ci"],
	});
	expect(project.services.db).toMatchObject({ worktree: "empty" });
});

describe("errors name the file and key, with no stack", () => {
	const invalid: [string, string, string][] = [
		["an unknown key", `{ name: "shop", app: {} }`, "unknown key `app`"],
		["a bad name", `{ name: "My Shop" }`, "`name`: must be a lowercase DNS label"],
		[
			"a bad app key",
			`{ name: "shop", apps: { Web: { run: "x" } } }`,
			"`apps.Web`: must be a lowercase DNS label",
		],
		[
			"an unknown app key",
			`{ name: "shop", apps: { web: { run: "x", host: "a.test" } } }`,
			"unknown key `apps.web.host`",
		],
		[
			"an app domain other than false",
			`{ name: "shop", apps: { web: { run: "x", domain: "a.test" } } }`,
			"`apps.web.domain`: `domain` can only be `false`, for an app served at `https://localhost:$PORT`",
		],
		[
			"an app with no port and no domain",
			`{ name: "shop", apps: { queue: { run: "x", port: false, domain: false } } }`,
			"`apps.queue.domain`: an app with no port has no domain already; drop `domain`",
		],
		[
			"a bad worktree prefix",
			`{ name: "shop", worktrees: { prefix: "Work Tree" } }`,
			"`worktrees.prefix`: must be a lowercase DNS label",
		],
		[
			"a cloned path outside the config's folder",
			`{ name: "shop", worktrees: { clone: ["../elsewhere"] } }`,
			"`worktrees.clone.0`: each must be a path inside the config's folder",
		],
		[
			"a bad Postgres worktree option",
			`{ name: "shop", services: { db: postgres({ worktree: "clone" as "copy" }) } }`,
			"`services.db.worktree`: Postgres `worktree` must be copy, empty or shared",
		],
		[
			"a bad Postgres version",
			`{ name: "shop", services: { db: postgres({ version: 16 as 17 }) } }`,
			"`services.db.version`: Postgres version must be 17 or 18",
		],
		[
			"a key that is both a service and an app",
			`{ name: "shop", services: { db: postgres() }, apps: { db: { run: "x" } } }`,
			"`apps.db`: a service has the same key; a key names one service or one app",
		],
	];
	test.each(invalid)("%s", async (_, body, reason) => {
		const dir = await scratch({ "basepad.config.ts": configFile(body) });
		const out = await box.basepad(dir, "status");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain(`basepad: ${join(dir, "basepad.config.ts")} is invalid:`);
		expect(out.stderr).toContain(reason);
		expect(out.stderr).not.toMatch(/\n\s+at /);
	});

	test("a config that throws", async () => {
		const dir = await scratch({
			"basepad.config.ts": `throw new Error("no luck");\nexport default {};\n`,
		});
		const out = await box.basepad(dir, "status");
		expect(out.code).toBe(1);
		expect(out.stderr).toBe(`basepad: ${join(dir, "basepad.config.ts")} failed to load: no luck\n`);
	});

	test("a missing config", async () => {
		const dir = await scratch({});
		const out = await box.basepad(dir, "status");
		expect(out.code).toBe(1);
		expect(out.stderr).toBe(
			`basepad: No basepad.config.ts in ${dir} or any folder above it. Run \`basepad init\` to write one.\n`,
		);
	});

	test("an over-long name, rejected with the reason", async () => {
		const name = "a".repeat(61);
		const body = `{ name: "${name}", services: { db: postgres() } }`;
		const dir = await scratch({ "basepad.config.ts": configFile(body) });
		const out = await box.basepad(dir, "status");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain(`database name "${name}_db", which is 64 bytes`);
	});
});

describe("basepad.config.local.ts", () => {
	test("is applied over the project's config", async () => {
		const dir = await scratch({
			"basepad.config.ts": twoApps,
			"basepad.config.local.ts": `import type { LocalConfig } from "@aysnc-labs/basepad";

const local: LocalConfig = (config) => ({
	...config,
	apps: { ...config.apps, web: { run: "next dev --turbo" } },
});
export default local;
`,
		});
		const project = await loadProject(dir);
		expect(project.apps.web?.run).toBe("next dev --turbo");
		expect(project.apps.cms?.run).toBe("npm run dev");
	});

	test("that throws gives an error naming it", async () => {
		const dir = await scratch({
			"basepad.config.ts": twoApps,
			"basepad.config.local.ts": `export default () => { throw new Error("bad override"); };\n`,
		});
		const out = await box.basepad(dir, "status");
		expect(out.code).toBe(1);
		expect(out.stderr).toBe(
			`basepad: ${join(dir, "basepad.config.local.ts")} threw: bad override\n`,
		);
	});

	test("whose result is invalid gives an error naming it", async () => {
		const dir = await scratch({
			"basepad.config.ts": twoApps,
			"basepad.config.local.ts": `export default (config) => ({ ...config, name: "Shop" });\n`,
		});
		const out = await box.basepad(dir, "status");
		expect(out.code).toBe(1);
		expect(out.stderr).toContain(`${join(dir, "basepad.config.local.ts")} is invalid:`);
	});
});
