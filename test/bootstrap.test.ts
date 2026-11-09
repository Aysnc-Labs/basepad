import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockOf, type Sandbox, sandbox } from "./sandbox.ts";

/** The shared tasks, included from this checkout as a project includes them from basepad's repo. */
const TASKS = resolve(import.meta.dirname, "../tasks");

let box: Sandbox;
let project: string;

beforeAll(async () => {
	box = await sandbox();
	project = await box.repo("cafe", {
		"mise.toml": `[task_config]\nincludes = ["mise-tasks", ${JSON.stringify(TASKS)}]\n`,
		"basepad.toml": [
			"[services.postgres]",
			"",
			"[ci.projects.app]",
			'paths = ["src"]',
			'run = "true"',
			"",
		].join("\n"),
		".gitignore": [".env.local", ".config/mise/conf.d/", ""].join("\n"),
	});
});
afterAll(async () => {
	await box?.dispose();
});

const until = async <T>(probe: () => Promise<T | undefined>, ms = 150_000): Promise<T> => {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 500));
	}
};
const envBlock = () => readFile(join(project, ".env.local"), "utf8").then(blockOf, () => undefined);

describe("the shared tasks", () => {
	test("a project that includes them gets status, changed, ci and bootstrap", async () => {
		const out = await box.mise(project, "tasks", "ls", "--json");
		expect(out.stderr).toBe("");
		const names = (JSON.parse(out.stdout) as { name: string }[]).map((t) => t.name).sort();
		expect(names).toEqual(["bootstrap", "changed", "ci", "status"]);
		const changed = await box.mise(project, "run", "--quiet", "changed", "--base", "HEAD");
		expect(changed.code).toBe(0);
		expect(changed.stdout).toBe("");
	});
});

describe("mise run bootstrap, as a cloud session's SessionStart hook", () => {
	test("does nothing outside a cloud session", async () => {
		const out = await box.miseWith(
			{ env: { CLAUDE_CODE_REMOTE: "" } },
			project,
			"run",
			"bootstrap",
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("");
		expect(await envBlock()).toBeUndefined();
	});

	test("returns at once, and brings the project's services up in the background", async () => {
		const started = Date.now();
		const out = await box.miseWith(
			{ env: { CLAUDE_CODE_REMOTE: "true" } },
			project,
			"run",
			"--quiet",
			"bootstrap",
		);
		expect(out.code).toBe(0);
		// The hook returns before Postgres is up: the session doesn't wait for the services.
		expect(await envBlock()).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(30_000);
		expect(out.stdout).toMatch(/background/);
		expect(out.stdout).toContain("basepad status");

		const vars = await until(envBlock);
		const select = await box.psql(vars.DATABASE_URL as string, "select 1");
		expect(select.stdout.trim()).toBe("1");
		const status = await until(async () => {
			const s = await box.mise(project, "run", "--quiet", "status");
			return /postgres\s+running/.test(s.stdout) ? s.stdout : undefined;
		});
		expect(status).toContain("cafe");
	});
});
