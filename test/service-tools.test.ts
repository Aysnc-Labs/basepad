import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box?.dispose());

const notCi = {
	CI: undefined,
	CONTINUOUS_INTEGRATION: undefined,
	GITHUB_ACTIONS: undefined,
	BUILD_NUMBER: undefined,
	RUN_ID: undefined,
};

const withNeonProxy = configFile(`{
	name: "tools-shop",
	services: { db: postgresWithNeonProxy() },
}`);

test("a project whose mise config has no Postgres gets the lines to add, and nothing starts", async () => {
	const dir = await box.project("bare", {
		"basepad.config.ts": withNeonProxy,
		"mise.toml": '[tools]\nmailpit = "1.33.1"\n',
	});

	const up = await box.basepad(dir, "up", "-d");

	expect(up.code).toBe(1);
	expect(up.stderr).toContain(
		`No tool in the mise config at ${dir} gives \`initdb\`, \`pg_ctl\`, \`postgres\`, \`psql\`, \`pg_dump\`, \`pg_restore\`, \`neon-proxy\`. Add these lines to ${join(dir, "mise.toml")}:

[tool_alias]
postgres = "github:aysnc-labs/prebuilt-binaries[version_prefix=postgres-]"
neon-proxy = "github:aysnc-labs/prebuilt-binaries[version_prefix=neon-proxy-]"

[tools]
postgres = "18.7-1"
neon-proxy = "8853"
`,
	);
	const status = await box.basepad(dir, "status");
	expect(status.stdout).toMatch(/^db +\S+ +stopped$/m);
	expect(status.stdout).toMatch(/^db-neon-proxy +\S+ +stopped$/m);
}, 120_000);

test("a project whose mise config has no Redis gets the prebuilt Redis lines", async () => {
	const dir = await box.project("no-redis", {
		"basepad.config.ts": configFile(`{ name: "tools-no-redis", services: { cache: redis() } }`),
		"mise.toml": '[tools]\nmailpit = "1.33.1"\n',
	});

	const up = await box.basepad(dir, "up", "-d");

	expect(up.code).toBe(1);
	expect(up.stderr).toContain(
		`No tool in the mise config at ${dir} gives \`redis-server\`. Add these lines to ${join(dir, "mise.toml")}:

[tool_alias]
redis = "github:aysnc-labs/prebuilt-binaries[version_prefix=redis-]"

[tools]
redis = "8.10.3"
`,
	);
	expect((await box.basepad(dir, "status")).stdout).toMatch(/^cache +\S+ +stopped$/m);
}, 120_000);

test("a project whose mise config has no Mailpit gets the Mailpit line", async () => {
	const dir = await box.project("no-mailpit", {
		"basepad.config.ts": configFile(`{ name: "tools-no-mailpit", services: { mail: mailpit() } }`),
		"mise.toml": '[tools]\n"conda:redis-server" = "8.10.3"\n',
	});

	const up = await box.basepad(dir, "up", "-d");

	expect(up.code).toBe(1);
	expect(up.stderr).toContain(
		`No tool in the mise config at ${dir} gives \`mailpit\`. Add these lines to ${join(dir, "mise.toml")}:

[tools]
mailpit = "1.33.1"
`,
	);
	expect((await box.basepad(dir, "status")).stdout).toMatch(/^mail +\S+ +stopped$/m);
}, 120_000);

test("an untrusted mise config fails up with mise's error and how to trust it, and basepad trusts nothing", async () => {
	const dir = await box.project("untrusted", {
		"basepad.config.ts": configFile(`{ name: "tools-untrusted", services: { db: postgres() } }`),
	});

	const up = await box.basepadWith(
		{ env: { ...notCi, MISE_TRUSTED_CONFIG_PATHS: undefined } },
		dir,
		"up",
		"-d",
	);

	expect(up.code).toBe(1);
	expect(up.stderr).toContain(`Config files in ${join(dir, "mise.toml")} are not trusted.`);
	expect(up.stderr).toContain(`\`mise trust ${join(dir, "mise.toml")}\``);
	expect(up.stderr).toContain("`trusted_config_paths`");
	const trusted = join(box.env.MISE_STATE_DIR as string, "trusted-configs");
	expect(existsSync(trusted) ? await readdir(trusted) : []).toEqual([]);
}, 120_000);

test("data from another Postgres major version is refused, naming the program", async () => {
	const dir = await box.project("switched", {
		"basepad.config.ts": configFile(`{ name: "tools-switched", services: { db: postgres() } }`),
	});
	const first = await box.basepad(dir, "up", "-d");
	expect(first.stderr).toBe("");
	expect((await box.basepad(dir, "down")).code).toBe(0);
	await writeFile(join(dir, "mise.toml"), '[tools]\n"conda:postgresql" = "17"\n');

	const up = await box.basepad(dir, "up", "-d");

	expect(up.code).toBe(1);
	expect(up.stderr).toMatch(
		/`db`'s data in \S+\/data is Postgres 18, but \S+conda-postgresql\S+\/postgres is Postgres 17\. Dump it with Postgres 18, remove that folder, then run `basepad up` again\./,
	);
}, 300_000);
