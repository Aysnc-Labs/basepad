import { type ChildProcess, execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PITCHFORK_VERSION } from "../src/versions.ts";
import { configFile, type Result, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const NAME = "neon-proxy-worktrees";
const query = join(import.meta.dirname, "apps/neon-query.mjs");
const session = join(import.meta.dirname, "apps/neon-session.mjs");

const config = (plain: string) =>
	configFile(`{
	name: "${NAME}",
	services: {
		db: postgresWithNeonProxy(),
		blank: postgresWithNeonProxy({ worktree: "empty" }),
		common: postgresWithNeonProxy({ worktree: "shared" }),
		plain: ${plain},
	},
	env: ({ db, blank, common, plain }) => ({
		".env.local": {
			DB_URL: db.url, DB_WS: db.wsProxy, DB_DIRECT: db.directUrl,
			BLANK_URL: blank.url, BLANK_WS: blank.wsProxy,
			COMMON_URL: common.url, COMMON_WS: common.wsProxy, COMMON_DIRECT: common.directUrl,
			PLAIN_URL: plain.url, PLAIN_WS: (plain as { wsProxy?: string }).wsProxy ?? "",
		},
	}),
}`);

let box: Sandbox;
let main: string;
let tree: string;
const sessions: ChildProcess[] = [];

const git = (cwd: string, ...args: string[]) =>
	promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});

const env = (dir: string) => readEnv(dir, ".env.local");

async function ok(dir: string, ...args: string[]): Promise<string> {
	const result = await box.basepad(dir, ...args);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	return result.stdout;
}

async function direct(url: string, sql: string): Promise<string> {
	const out = await box.psql([url], sql);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

async function throughProxy(dir: string, key: string, sql: string): Promise<Result> {
	const vars = await env(dir);
	const prefix = key.toUpperCase();
	return box.run(process.execPath, [
		query,
		vars[`${prefix}_URL`] as string,
		vars[`${prefix}_WS`] as string,
		sql,
	]);
}

async function rowsThroughProxy(dir: string, key: string, sql: string): Promise<unknown> {
	const out = await throughProxy(dir, key, sql);
	expect(out.stderr).toBe("");
	return JSON.parse(out.stdout);
}

interface Session {
	ask(sql: string): Promise<{ rows?: unknown[]; error?: string }>;
}

async function openSession(dir: string, key: string): Promise<Session> {
	const vars = await env(dir);
	const prefix = key.toUpperCase();
	const child = spawn(
		process.execPath,
		[session, vars[`${prefix}_URL`] as string, vars[`${prefix}_WS`] as string],
		{ cwd: box.root, env: box.env, stdio: ["pipe", "pipe", "inherit"] },
	);
	sessions.push(child);
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	return {
		async ask(sql) {
			child.stdin.write(`${sql}\n`);
			const { value, done } = await lines.next();
			if (done) throw new Error("The session ended.");
			return JSON.parse(value);
		},
	};
}

async function squat(port: number): Promise<Server> {
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return server;
}

async function pitchfork(...args: string[]): Promise<void> {
	const home = join(box.root, "home/pitchfork");
	await promisify(execFile)(
		"mise",
		["exec", `pitchfork@${PITCHFORK_VERSION}`, "--", "pitchfork", ...args],
		{
			cwd: box.root,
			env: {
				...box.env,
				PITCHFORK_STATE_DIR: join(home, "state"),
				PITCHFORK_CONFIG_DIR: join(home, "config"),
				PITCHFORK_LOGS_DIR: join(home, "logs"),
				MISE_SKILLS_FETCH: "false",
			},
		},
	);
}

beforeAll(async () => {
	box = await sandbox();
	main = await box.project(NAME, {
		"basepad.config.ts": config("postgres()"),
		".gitignore": "node_modules\n.env.local\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	await ok(main, "up");
	const vars = await env(main);
	for (const key of ["DB_DIRECT", "COMMON_DIRECT", "PLAIN_URL"]) {
		await direct(
			vars[key] as string,
			"create table notes (body text); insert into notes values ('from main')",
		);
	}
	await ok(main, "worktree", "add");
	tree = join(box.root, `${NAME}.worktrees/worktree-1`);
	await direct(
		(await env(tree)).DB_DIRECT as string,
		"update notes set body = 'from the worktree'",
	);
}, 300_000);
afterAll(async () => {
	for (const child of sessions) child.kill();
	await box?.dispose();
});

test("each checkout's url names its own database and reaches it through main's proxy", async () => {
	const mains = await env(main);
	const trees = await env(tree);
	const note = "select current_database() as db, (select body from notes) as note";
	expect(await rowsThroughProxy(main, "db", note)).toEqual([
		{ db: "neon_proxy_worktrees_db", note: "from main" },
	]);
	expect(await rowsThroughProxy(tree, "db", note)).toEqual([
		{ db: "neon_proxy_worktrees_db_worktree_1", note: "from the worktree" },
	]);
	expect(
		await rowsThroughProxy(
			tree,
			"blank",
			"select current_database() as db, to_regclass('notes') is null as empty",
		),
	).toEqual([{ db: "neon_proxy_worktrees_blank_worktree_1", empty: true }]);
	expect(await rowsThroughProxy(tree, "common", note)).toEqual([
		{ db: "neon_proxy_worktrees_common", note: "from main" },
	]);
	for (const key of ["DB_WS", "BLANK_WS", "COMMON_WS"]) expect(trees[key]).toBe(mains[key]);
});

test("db save, db load and a worktree copy succeed while a Pool holds connections through the proxy, and the Pool reconnects", async () => {
	const pool = await openSession(main, "db");
	const notes = "select body from notes order by body";
	expect(await pool.ask(notes)).toEqual({ rows: [{ body: "from main" }] });
	await ok(main, "db", "save", "before", "--service", "db");
	expect(await pool.ask("insert into notes values ('later')")).toEqual({ rows: [] });
	await ok(main, "db", "load", "before", "--service", "db");
	expect(await pool.ask(notes)).toEqual({ rows: [{ body: "from main" }] });
	await ok(main, "worktree", "add");
	expect(await pool.ask(notes)).toEqual({ rows: [{ body: "from main" }] });
}, 120_000);

test("switching a service from postgres() to postgresWithNeonProxy() keeps its data and its worktree's", async () => {
	await direct(
		(await env(tree)).PLAIN_URL as string,
		"update notes set body = 'from the worktree'",
	);
	const switched = config("postgresWithNeonProxy()");
	await writeFile(join(main, "basepad.config.ts"), switched);
	await writeFile(join(tree, "basepad.config.ts"), switched);
	await ok(main, "up");
	await ok(tree, "up");
	const note = "select body from notes";
	expect(await rowsThroughProxy(main, "plain", note)).toEqual([{ body: "from main" }]);
	expect(await rowsThroughProxy(tree, "plain", note)).toEqual([{ body: "from the worktree" }]);
}, 120_000);

test("a taken proxy port moves the proxy to the next free one, and the env file follows", async () => {
	const before = (await env(main)).DB_WS as string;
	const port = Number(new URL(`ws://${before}`).port);
	await ok(main, "down");
	const squatter = await squat(port);
	try {
		await ok(main, "up");
		const after = (await env(main)).DB_WS as string;
		expect(Number(new URL(`ws://${after}`).port)).toBeGreaterThan(port);
		expect(await rowsThroughProxy(main, "db", "select 1 as one")).toEqual([{ one: 1 }]);
	} finally {
		await new Promise((resolve) => squatter.close(resolve));
	}
}, 120_000);

test("when Postgres comes back on another port, up restarts the proxy against it", async () => {
	const before = Number(new URL((await env(main)).DB_DIRECT as string).port);
	await pitchfork("stop", `${NAME}/db`);
	const squatter = await squat(before);
	try {
		await ok(main, "up");
		const after = Number(new URL((await env(main)).DB_DIRECT as string).port);
		expect(after).not.toBe(before);
		expect(await rowsThroughProxy(main, "db", "select 1 as one")).toEqual([{ one: 1 }]);
	} finally {
		await new Promise((resolve) => squatter.close(resolve));
	}
}, 120_000);

test("a worktree's up follows main's proxy to its new port", async () => {
	const before = (await env(main)).DB_WS as string;
	await ok(main, "down");
	const squatter = await squat(Number(new URL(`ws://${before}`).port));
	try {
		await ok(main, "up");
		const moved = (await env(main)).DB_WS as string;
		expect(moved).not.toBe(before);
		await ok(tree, "up");
		expect((await env(tree)).DB_WS).toBe(moved);
		expect(await rowsThroughProxy(tree, "db", "select body from notes")).toEqual([
			{ body: "from the worktree" },
		]);
	} finally {
		await new Promise((resolve) => squatter.close(resolve));
	}
}, 120_000);
