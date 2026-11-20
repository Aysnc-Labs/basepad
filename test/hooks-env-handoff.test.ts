import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
beforeAll(async () => {
	box = await sandbox();
});
afterAll(() => box?.dispose());

test("a hook gets an env file value with shell metacharacters unchanged", async () => {
	const weird = `a'b "c" $HOME \`id\` \\ ; & | *\nline2`;
	const dir = await box.project("t67quote", {
		"basepad.config.ts": configFile(`{
			name: "t67quote",
			apps: { web: { run: "sleep 60" } },
			env: () => ({ ".env.local": { WEIRD: ${JSON.stringify(weird)} } }),
			hooks: { afterUp: 'printf %s "$WEIRD" > weird' },
		}`),
	});

	expect((await box.basepad(dir, "up")).code).toBe(0);

	expect(await readFile(join(dir, "weird"), "utf8")).toBe(weird);
	await box.basepad(dir, "down");
}, 120_000);

test("a hook gets env file keys that together pass one argument's size limit", async () => {
	const big = "x".repeat(50_000);
	const dir = await box.project("t67bigenv", {
		"basepad.config.ts": configFile(`{
			name: "t67bigenv",
			apps: { web: { run: "sleep 60" } },
			env: () => ({ ".env.local": { A: "${big}", B: "${big}", C: "${big}" } }),
			hooks: { afterUp: 'printf %s "$A$B$C" | wc -c > size' },
		}`),
	});

	expect((await box.basepad(dir, "up")).code).toBe(0);

	expect((await readFile(join(dir, "size"), "utf8")).trim()).toBe("150000");
	await box.basepad(dir, "down");
}, 120_000);

test("no process command line shows an env file value while a hook runs", async () => {
	const secret = "t67-canary-secret";
	const dir = await box.project("t67argv", {
		"basepad.config.ts": configFile(`{
			name: "t67argv",
			apps: { web: { run: "sleep 60" } },
			env: () => ({ ".env.local": { API_SECRET: "${secret}" } }),
			hooks: { afterUp: ["true", "true", "true", "true", "true"] },
		}`),
	});
	let seen = "";
	let stop = false;
	const poll = (async () => {
		while (!stop) {
			const ps = await promisify(execFile)("ps", ["-eo", "args", "-ww"]);
			seen += ps.stdout
				.split("\n")
				.filter((line) => line.includes(secret) && !line.startsWith("ps "))
				.join("\n");
		}
	})();

	await box.basepad(dir, "up");
	stop = true;
	await poll;

	expect(seen).toBe("");
	await box.basepad(dir, "down");
}, 120_000);

test("a hook runs with the other keys when an env file key's name isn't a shell name", async () => {
	const dir = await box.project("t67dotted", {
		"basepad.config.ts": configFile(`{
			name: "t67dotted",
			apps: { web: { run: "sleep 60" } },
			env: () => ({ ".env.local": { "app.key": "dotted", PLAIN: "plain" } }),
			hooks: { afterUp: 'echo "$PLAIN" > keys' },
		}`),
	});

	expect((await box.basepad(dir, "up")).code).toBe(0);

	expect(await readFile(join(dir, "keys"), "utf8")).toBe("plain\n");
	await box.basepad(dir, "down");
}, 120_000);
