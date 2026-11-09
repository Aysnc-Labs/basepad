import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
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
	/** A scratch project that is also a git repo, its files committed on `main`. */
	repo(name: string, files?: Record<string, string>): Promise<string>;
	git(cwd: string, ...args: string[]): Promise<Result>;
	basepad(cwd: string, ...args: string[]): Promise<Result>;
	/** `basepad` with extra environment variables and, optionally, standard input. */
	basepadWith(
		options: { env?: NodeJS.ProcessEnv; input?: string },
		cwd: string,
		...args: string[]
	): Promise<Result>;
	mise(cwd: string, ...args: string[]): Promise<Result>;
	/** `mise` with extra environment variables. */
	miseWith(options: { env?: NodeJS.ProcessEnv }, cwd: string, ...args: string[]): Promise<Result>;
	/** psql from basepad's Postgres, as a developer would run it. */
	psql(url: string, sql: string): Promise<Result>;
	/** Runs one of the test dir's scripts with Node, as an app would run. */
	node(script: string, ...args: string[]): Promise<Result>;
	/** redis-cli against a Redis URL. */
	redis(url: string, ...args: string[]): Promise<Result>;
	dispose(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
	// Short and real (macOS's tmpdir is a symlink): unix socket paths have a ~104-byte limit.
	const root = await realpath(
		await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bp-")),
	);
	const home = join(root, "home");
	// `basepad` on PATH, as installed, so a project's hooks can call it.
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "basepad"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`);
	await chmod(join(bin, "basepad"), 0o755);
	const env: NodeJS.ProcessEnv = {
		...stripMise(process.env),
		PATH: `${bin}:${process.env.PATH}`,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "basepad",
		GIT_AUTHOR_EMAIL: "tests@basepad.invalid",
		GIT_COMMITTER_NAME: "basepad",
		GIT_COMMITTER_EMAIL: "tests@basepad.invalid",
		BASEPAD_HOME: home,
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
		input?: string,
	): Promise<Result> => {
		try {
			const child = run(file, args, { cwd, env: { ...env, ...extra }, maxBuffer: 16 << 20 });
			child.child.stdin?.end(input);
			const { stdout, stderr } = await child;
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
		async repo(name, files = {}) {
			const dir = await self.project(name, files);
			await exec("git", ["init", "--quiet", "--initial-branch=main"], dir);
			await exec("git", ["add", "--all"], dir);
			await exec("git", ["commit", "--quiet", "--message", "Start"], dir);
			return dir;
		},
		git: (cwd, ...args) => exec("git", args, cwd),
		basepad: (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd),
		basepadWith: (options, cwd, ...args) =>
			exec(process.execPath, [cli, ...args], cwd, options.env, options.input),
		mise: (cwd, ...args) => exec("mise", args, cwd),
		miseWith: (options, cwd, ...args) => exec("mise", args, cwd, options.env),
		psql: (url, sql) =>
			exec("mise", ["exec", "postgres@18", "--", "psql", url, "-tAX", "-c", sql], root),
		redis: (url, ...args) =>
			exec("mise", ["exec", "redis@8", "--", "redis-cli", "-u", url, ...args], root),
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

/** The variables in an env file's basepad block. */
export function blockOf(envFile: string): Record<string, string> {
	const match = envFile.match(/# >>> basepad[^\n]*\n([\s\S]*?)# <<< basepad\n/);
	if (!match?.[1]) throw new Error(`no basepad block in:\n${envFile}`);
	return Object.fromEntries(
		match[1]
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

/**
 * Sends one message through an `smtp://user:pass@host:port` URL, as an app's mailer would:
 * EHLO, AUTH PLAIN with the URL's credentials, then the message.
 */
export async function sendMail(
	url: string,
	message: { from: string; to: string; subject: string },
): Promise<void> {
	const { hostname, port, username, password } = new URL(url);
	const socket = createConnection({ host: hostname, port: Number(port) });
	socket.setEncoding("utf8");
	let buffer = "";
	const waiting: ((line: string) => void)[] = [];
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		// A reply ends with a line whose code is followed by a space: "250 OK", not "250-AUTH".
		for (
			let at = buffer.search(/^\d{3} .*\r\n/m);
			at !== -1;
			at = buffer.search(/^\d{3} .*\r\n/m)
		) {
			const end = buffer.indexOf("\r\n", at) + 2;
			const reply = buffer.slice(0, end);
			buffer = buffer.slice(end);
			waiting.shift()?.(reply);
		}
	});
	const reply = () => new Promise<string>((resolve) => waiting.push(resolve));
	const expectReply = async (code: string) => {
		const got = await reply();
		if (!got.startsWith(code)) throw new Error(`SMTP: expected ${code}, got ${got}`);
	};
	const send = async (line: string, code: string) => {
		const next = expectReply(code);
		socket.write(`${line}\r\n`);
		await next;
	};
	try {
		await expectReply("220");
		await send("EHLO test.localhost", "250");
		const auth = Buffer.from(
			`\0${decodeURIComponent(username)}\0${decodeURIComponent(password)}`,
		).toString("base64");
		await send(`AUTH PLAIN ${auth}`, "235");
		await send(`MAIL FROM:<${message.from}>`, "250");
		await send(`RCPT TO:<${message.to}>`, "250");
		await send("DATA", "354");
		await send(
			[
				`From: ${message.from}`,
				`To: ${message.to}`,
				`Subject: ${message.subject}`,
				"",
				"Sent by basepad's tests.",
				".",
			].join("\r\n"),
			"250",
		);
		await send("QUIT", "221");
	} finally {
		socket.destroy();
	}
}
