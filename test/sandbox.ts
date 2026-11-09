import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/cli.js");

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * A machine of its own: basepad's home, mise's state and config, and pitchfork's state live in a
 * temp dir, so a test never sees the user's real services and never collides with another lane.
 * Tool installs stay in mise's shared data dir, so Postgres downloads once.
 */
export interface Sandbox {
	root: string;
	home: string;
	env: NodeJS.ProcessEnv;
	/** Makes a scratch project: a dir with a trusted `mise.toml`, plus any extra files. */
	project(name: string, files?: Record<string, string>): Promise<string>;
	basepad(cwd: string, ...args: string[]): Promise<Result>;
	mise(cwd: string, ...args: string[]): Promise<Result>;
	/** psql from basepad's Postgres, as a developer would run it. */
	psql(url: string, sql: string): Promise<Result>;
	/** Runs one of the test dir's scripts with Node, as an app would run. */
	node(script: string, ...args: string[]): Promise<Result>;
	dispose(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
	// Short and real (macOS's tmpdir is a symlink): unix socket paths have a ~104-byte limit.
	const root = await realpath(
		await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bp-")),
	);
	const home = join(root, "home");
	const env: NodeJS.ProcessEnv = {
		...stripMise(process.env),
		BASEPAD_HOME: home,
		MISE_STATE_DIR: join(root, "mise-state"),
		MISE_CONFIG_DIR: join(root, "mise-config"),
		PITCHFORK_STATE_DIR: join(root, "pf-state"),
		PITCHFORK_CONFIG_DIR: join(root, "pf-config"),
		PITCHFORK_LOGS_DIR: join(root, "pf-logs"),
		NO_COLOR: "1",
	};

	const exec = async (file: string, args: string[], cwd: string): Promise<Result> => {
		try {
			const { stdout, stderr } = await run(file, args, { cwd, env, maxBuffer: 16 << 20 });
			return { code: 0, stdout, stderr };
		} catch (error) {
			const e = error as { code?: number; stdout?: string; stderr?: string };
			return {
				code: typeof e.code === "number" ? e.code : 1,
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? "",
			};
		}
	};

	const self: Sandbox = {
		root,
		home,
		env,
		async project(name, files = {}) {
			const dir = join(root, name);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "mise.toml"), files["mise.toml"] ?? "[tools]\n");
			for (const [path, content] of Object.entries(files)) {
				if (path !== "mise.toml") await writeFile(join(dir, path), content);
			}
			await exec("mise", ["trust", "--quiet", dir], dir);
			return dir;
		},
		basepad: (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd),
		mise: (cwd, ...args) => exec("mise", args, cwd),
		psql: (url, sql) =>
			exec("mise", ["exec", "postgres@18", "--", "psql", url, "-tAX", "-c", sql], root),
		node: (script, ...args) =>
			exec(process.execPath, [join(import.meta.dirname, script), ...args], root),
		async dispose() {
			// Stops basepad's daemons and this sandbox's supervisor; the user's own are untouched.
			await exec(
				"mise",
				["exec", "pitchfork@2.33.1", "--", "pitchfork", "supervisor", "stop"],
				root,
			);
			await rm(root, { recursive: true, force: true });
		},
	};
	return self;
}

/** Drops the parent shell's mise activation, so it can't leak config from the developer's cwd. */
function stripMise(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("__MISE")));
}
