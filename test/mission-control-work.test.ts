import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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

test("an addition killed after it made its worktree names it and how to remove it", async () => {
	// As `worktree add` prints once its git worktree is there, before its setup runs.
	const { command, dir } = basepad(`
		console.log("Worktree shop-2 is checked out at /code/shop-2.");
		console.log("Running \`npm install\`");
		process.kill(process.ppid, "SIGKILL");`);
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" }, before: ["shop-1"] });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Could not add a worktree: it stopped partway, leaving shop-2; run `basepad worktree rm shop-2` to remove it. Its last line: Running `npm install`",
	]);
});

test("a removal killed partway names how to finish it", async () => {
	const { command, dir } = basepad(`process.kill(process.ppid, "SIGKILL");`);
	const order = {
		kind: "remove",
		suffix: "shop-2",
		namespace: "shop.shop-2",
		force: true,
	} as const;
	await startWork({ dir, command, cwd: tmpdir(), order });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Could not remove shop-2: it stopped partway; run `basepad worktree rm shop-2 --force` to finish it. Its last line: ran worktree rm shop-2 --force",
	]);
});

/**
 * A record left on disk as if by an earlier view: `pid`, its process (`{ pid, start }`), or none
 * when the view crashed before its command ran. `age` in ms.
 */
function leftover(dir: string, pid: object | undefined, age = 0): void {
	mkdirSync(dir, { recursive: true });
	const base = join(dir, "1-1-left");
	writeFileSync(
		`${base}.json`,
		JSON.stringify({ kind: "add", title: "Adding a worktree", before: [] }),
	);
	writeFileSync(`${base}.log`, "Running `npm install`\n");
	if (pid !== undefined) writeFileSync(`${base}.pid`, JSON.stringify(pid));
	aged(`${base}.json`, age);
}

/** Makes a file `age` ms old. */
function aged(file: string, age: number): void {
	const then = (Date.now() - age) / 1000;
	utimesSync(file, then, then);
}

const stopped =
	"Could not add a worktree: it stopped partway. Its last line: Running `npm install`";

test("a record whose pid is now another process's (reused, after a reboot) is not taken for running work", async () => {
	const { dir } = basepad("");
	// This test's own process, alive, but not the one the record started.
	leftover(dir, { pid: process.pid, start: "not its start" });
	expect(await takeWork(dir)).toEqual({ running: [], finished: [stopped] });
	expect(readdirSync(dir)).toEqual([]);
});

test("a process whose start could not be read is running while its pid is; once gone, it stopped", async () => {
	const { dir } = basepad("");
	leftover(dir, { pid: process.pid });
	expect((await takeWork(dir)).running).toHaveLength(1);
	const gone = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], {
		encoding: "utf8",
	});
	leftover(dir, { pid: Number(gone.stdout) });
	expect(await takeWork(dir)).toEqual({ running: [], finished: [stopped] });
});

test("a record whose command never started is under way briefly, then given up, never hiding worktrees for good", async () => {
	const { dir } = basepad("");
	leftover(dir, undefined);
	expect((await takeWork(dir)).running).toHaveLength(1);
	leftover(dir, undefined, 60_000);
	expect((await takeWork(dir)).finished).toHaveLength(1);
	expect(readdirSync(dir)).toEqual([]);
});

test("files left without a record (a view that died while taking one, a command given up) go once a minute old, untold", async () => {
	const { dir } = basepad("");
	mkdirSync(dir, { recursive: true });
	const files = ["1-a.taken", "1-a.log", "1-a.exit", "2-b.log", "2-b.exit", "3-c.pid"];
	for (const file of files) {
		writeFileSync(join(dir, file), "0\n");
		aged(join(dir, file), 120_000);
	}
	writeFileSync(join(dir, "4-d.exit"), "0\n");
	expect(await takeWork(dir)).toEqual({ running: [], finished: [] });
	expect(readdirSync(dir)).toEqual(["4-d.exit"]);
});

test("a job that ends at once is told once, however often it is read while it starts", async () => {
	const { command, dir } = basepad("");
	const told: string[] = [];
	let starting = true;
	const reading = (async () => {
		while (starting) told.push(...(await takeWork(dir)).finished);
	})();
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" } });
	await new Promise((resolve) => setTimeout(resolve, 300));
	starting = false;
	await reading;
	told.push(...(await until(dir, (w) => w.running.length === 0)).finished);
	expect(told).toEqual(["ran worktree add"]);
});

test("two views reading finished work at once: only one tells it, whole", async () => {
	const { command, dir } = basepad(`console.log("Made worktree shop-1.");`);
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" } });
	for (let i = 0; i < 250 && !readdirSync(dir).some((n) => n.endsWith(".exit")); i++)
		await new Promise((resolve) => setTimeout(resolve, 20));
	const [a, b] = await Promise.all([takeWork(dir), takeWork(dir)]);
	expect([...(a?.finished ?? []), ...(b?.finished ?? [])]).toEqual(["Made worktree shop-1."]);
	expect(readdirSync(dir)).toEqual([]);
});

test("an addition killed before it made anything names no worktree another made meanwhile", async () => {
	// Killed at once: it printed nothing of a worktree. shop-2 is the developer's own, made by
	// `basepad worktree add` in a shell before the view read the record: it must not be named.
	const { command, dir } = basepad(`process.kill(process.ppid, "SIGKILL");`);
	await startWork({ dir, command, cwd: tmpdir(), order: { kind: "add" }, before: ["shop-1"] });
	const [told] = (await until(dir, (w) => w.finished.length > 0)).finished;
	expect(told).toMatch(/^Could not add a worktree: it stopped partway/);
	expect(told).not.toContain("shop-2");
});

test("work killed before it printed anything says no last line", async () => {
	const { dir } = basepad("");
	// Not the stand-in, which prints what it was asked first.
	const silent = [process.execPath, "-e", `process.kill(process.ppid, "SIGKILL");`];
	await startWork({ dir, command: silent, cwd: tmpdir(), order: { kind: "add" } });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Could not add a worktree: it stopped partway.",
	]);
	const order = {
		kind: "remove",
		suffix: "shop-2",
		namespace: "shop.shop-2",
		force: false,
	} as const;
	await startWork({ dir, command: silent, cwd: tmpdir(), order });
	expect((await until(dir, (w) => w.finished.length > 0)).finished).toEqual([
		"Could not remove shop-2: it stopped partway; run `basepad worktree rm shop-2` to finish it.",
	]);
});
