import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "dist/launcher.js");

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * A machine of its own: basepad's home, mise's state and config, and pitchfork's state live in a
 * temp dir, so a test never sees the user's real setup and never collides with another lane.
 * Tool installs stay in mise's data dir (`MISE_DATA_DIR`, else the user's), so tools download once.
 */
export interface Sandbox {
	root: string;
	env: NodeJS.ProcessEnv;
	/**
	 * Makes a scratch project: a dir holding `files` (paths may have folders), with basepad
	 * installed in its `node_modules` as `npm install` would, so its config's import resolves.
	 */
	project(name: string, files?: Record<string, string>): Promise<string>;
	/** Runs the built `basepad` bin in `cwd`, as a developer would. */
	basepad(cwd: string, ...args: string[]): Promise<Result>;
	/** `basepad` with extra environment variables, or under another program (an older Node). */
	basepadWith(
		options: { env?: NodeJS.ProcessEnv; via?: string[] },
		cwd: string,
		...args: string[]
	): Promise<Result>;
	dispose(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
	// Short and real (macOS's tmpdir is a symlink): unix socket paths have a ~104-byte limit.
	const root = await realpath(
		await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bp-")),
	);
	const env: NodeJS.ProcessEnv = {
		...stripMise(process.env),
		BASEPAD_HOME: join(root, "home"),
		MISE_STATE_DIR: join(root, "mise-state"),
		MISE_CONFIG_DIR: join(root, "mise-config"),
		PITCHFORK_STATE_DIR: join(root, "pf-state"),
		PITCHFORK_CONFIG_DIR: join(root, "pf-config"),
		PITCHFORK_LOGS_DIR: join(root, "pf-logs"),
		NO_COLOR: "1",
	};

	const exec = async (
		file: string,
		args: string[],
		cwd: string,
		extra: NodeJS.ProcessEnv = {},
	): Promise<Result> => {
		try {
			const { stdout, stderr } = await run(file, args, {
				cwd,
				env: { ...env, ...extra },
				maxBuffer: 16 << 20,
			});
			return { code: 0, stdout, stderr };
		} catch (error) {
			const e = error as { code?: number | string; stdout?: string; stderr?: string };
			if (typeof e.code === "string") throw error;
			return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
		}
	};

	return {
		root,
		env,
		async project(name, files = {}) {
			const dir = join(root, name);
			await mkdir(dir, { recursive: true });
			for (const [path, content] of Object.entries(files)) {
				await mkdir(dirname(join(dir, path)), { recursive: true });
				await writeFile(join(dir, path), content);
			}
			await mkdir(join(dir, "node_modules/@aysnc-labs"), { recursive: true });
			await symlink(repo, join(dir, "node_modules/@aysnc-labs/basepad"));
			return dir;
		},
		basepad: (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd),
		basepadWith: (options, cwd, ...args) => {
			const [file, ...via] = options.via ?? [process.execPath];
			return exec(file as string, [...via, cli, ...args], cwd, options.env);
		},
		async dispose() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Drops the parent shell's mise activation, so it can't leak config from the developer's cwd. */
function stripMise(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("__MISE")));
}

/** A `basepad.config.ts` exporting `body` through `defineConfig`. */
export function configFile(body: string): string {
	return `import { defineConfig, postgres } from "@aysnc-labs/basepad";\n\nexport default defineConfig(${body});\n`;
}
