import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startWork, takeWork } from "../src/mission-control/work.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for the `basepad` command: prints what it was asked, then runs `body`, a script with
 * `args` and `go` (a file to wait for) in scope.
 */
function basepad(body: string): { command: string[]; dir: string; go: string } {
	const dir = mkdtempSync(join(tmpdir(), "basepad-work-"));
	dirs.push(dir);
	const go = join(dir, "go");
	const script = `
		const { existsSync } = require("node:fs");
		const args = process.argv.slice(1);
		const go = ${JSON.stringify(go)};
		const wait = (then) => { const t = setInterval(() => { if (existsSync(go)) { clearInterval(t); then(); } }, 20); };
		console.log("ran " + args.join(" "));
		${body}`;
	return { command: [process.execPath, "-e", script], dir: join(dir, "work"), go };
}

/** `takeWork` again until `done` says what it read is what the test waits for. */
async function until(dir: string, done: (work: Awaited<ReturnType<typeof takeWork>>) => boolean) {
	for (let i = 0; i < 250; i++) {
		const work = await takeWork(dir);
		if (done(work)) return work;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out");
}

test("an addition runs `basepad worktree add`: its last line shows while it runs, and once done it says how it ended, once", async () => {
	const { command, dir, go } = basepad(`
		console.log("Running \`npm install\`");
		wait(() => console.log("Made worktree shop-1 at /code/shop-1, on branch shop-1."));`);
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" }, before: ["shop-2"] });
	const running = await until(dir, (w) => w.running[0]?.line === "Running `npm install`");
	expect(running).toEqual({
		running: [
			{
				kind: "add",
				title: "Adding a worktree",
				line: "Running `npm install`",
				before: ["shop-2"],
			},
		],
		finished: [],
	});
	writeFileSync(go, "");
	const done = await until(dir, (w) => w.finished.length > 0);
	expect(done).toEqual({
		running: [],
		finished: ["Made worktree shop-1 at /code/shop-1, on branch shop-1."],
	});
	expect(await takeWork(dir)).toEqual({ running: [], finished: [] });
	expect(readdirSync(dir)).toEqual([]);
});

test("a removal runs `basepad worktree rm`, with --force only when asked", async () => {
	const { command, dir } = basepad("");
	const removal = { kind: "remove", suffix: "shop-1", namespace: "shop.shop-1" } as const;
	await startWork({ dir, command, cwd: tmpdir(), order: { ...removal, force: false } });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"ran worktree rm shop-1",
	]);
	await startWork({ dir, command, cwd: tmpdir(), order: { ...removal, force: true } });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"ran worktree rm shop-1 --force",
	]);
});

test("while it runs, a removal names its worktree", async () => {
	const { command, dir, go } = basepad("wait(() => {});");
	const order = {
		kind: "remove",
		suffix: "shop-1",
		namespace: "shop.shop-1",
		force: false,
	} as const;
	await startWork({ dir, command, cwd: tmpdir(), order });
	const { running } = await until(dir, (w) => w.running[0]?.line !== undefined);
	expect(running).toEqual([
		{
			kind: "remove",
			title: "Removing shop-1",
			namespace: "shop.shop-1",
			line: "ran worktree rm shop-1",
		},
	]);
	writeFileSync(go, "");
	await until(dir, (w) => w.finished.length > 0);
});

test("a command that fails says its error's first and last line", async () => {
	const { command, dir } = basepad(`
		console.log("Running \`npm ci\`");
		console.error("basepad: Setup command \`npm ci\` failed (exit 1). Its output:\\n  npm ERR! missing lockfile\\nWorktree shop-1 is checked out at /code/shop-1; once that is fixed, run the rest of \`worktrees.setup\` there.");
		process.exitCode = 1;`);
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" } });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Could not add a worktree: Setup command `npm ci` failed (exit 1). Its output: … Worktree shop-1 is checked out at /code/shop-1; once that is fixed, run the rest of `worktrees.setup` there.",
	]);
});

test("it goes on after the process that started it has gone, as the view does on q", async () => {
	const { command, dir, go } = basepad(`wait(() => console.log("Made worktree shop-1."));`);
	const work = new URL("../src/mission-control/work.ts", import.meta.url).pathname;
	const started = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { startWork } from ${JSON.stringify(work)};
			await startWork({ dir: ${JSON.stringify(dir)}, command: ${JSON.stringify(command)}, cwd: "/", order: { kind: "add" } });`,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
	expect(started.stderr).toBe("");
	expect(started.status).toBe(0);
	expect((await takeWork(dir)).running).toHaveLength(1);
	writeFileSync(go, "");
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Made worktree shop-1.",
	]);
});

test("one whose process was killed partway says so, with its last line", async () => {
	// It kills the shell that runs it, then stops: no one says how it ended.
	const { command, dir } = basepad(`process.kill(process.ppid, "SIGKILL");`);
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" } });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Could not add a worktree: it stopped partway. Its last line: ran worktree add",
	]);
	expect(existsSync(dir) && readdirSync(dir)).toEqual([]);
});
