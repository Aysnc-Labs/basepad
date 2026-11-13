import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createConnection, createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PITCHFORK_VERSION } from "../src/versions.ts";

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
 * temp dir, and basepad's proxy has a free port of its own, so a test never sees the user's real
 * setup and never collides with another lane. The `PITCHFORK_*` dirs stand for a developer's own
 * pitchfork, which basepad must leave alone.
 * Tool installs stay in mise's data dir (`MISE_DATA_DIR`, else the user's), so tools download once.
 */
export interface Sandbox {
	root: string;
	env: NodeJS.ProcessEnv;
	/** The port basepad's HTTPS proxy listens on. */
	proxyPort: number;
	/** The certificate authority basepad's proxy signs with, once `up` has run. */
	ca(): Promise<string>;
	/**
	 * Makes a scratch project: a dir holding `files` (paths may have folders), with basepad
	 * installed in its `node_modules` as `npm install` would, so its config's import resolves.
	 */
	project(name: string, files?: Record<string, string>): Promise<string>;
	/** Runs the built `basepad` bin in `cwd`, as a developer would. */
	basepad(cwd: string, ...args: string[]): Promise<Result>;
	/** Runs a program in the sandbox's root with its environment. */
	run(file: string, args: string[]): Promise<Result>;
	/** Runs `psql` from mise's Postgres 18 with `args` (a URL, or `-h`, `-p` and the rest). */
	psql(args: string[], sql: string): Promise<Result>;
	/** Runs `redis-cli` from mise's Redis 8 against a Redis URL. */
	redis(url: string, ...args: string[]): Promise<Result>;
	/** Runs `sql` against the `DATABASE_URL` that `up` wrote to the project's `.env.local`. */
	sql(project: string, sql: string): Promise<Result>;
	/**
	 * GETs a URL through basepad's proxy on 127.0.0.1, trusting only the sandbox's certificate
	 * authority, and returns its JSON body. Rejects on any status but 200.
	 */
	get<T = unknown>(url: string): Promise<T>;
	/**
	 * `basepad` with extra environment variables, under another program (an older Node), or with
	 * `input` on its standard input.
	 */
	basepadWith(
		options: { env?: NodeJS.ProcessEnv; via?: string[]; input?: string },
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
	const proxyPort = await freePort();
	env.BASEPAD_PROXY_PORT = String(proxyPort);

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
			const e = error as {
				code?: number | string | null;
				signal?: NodeJS.Signals | null;
				stdout?: string;
				stderr?: string;
			};
			if (typeof e.code === "string") throw error;
			const stdout = e.stdout ?? "";
			const stderr = e.stderr ?? "";
			// A kill is not an exit: report it as a shell does (128 + n), and name it.
			if (e.signal) {
				const code = 128 + (constants.signals[e.signal] ?? 0);
				return { code, stdout, stderr: `${stderr}[killed by ${e.signal}]` };
			}
			return { code: e.code ?? 1, stdout, stderr };
		}
	};

	const ca = () => readFile(join(root, "home/pitchfork/state/proxy/ca.pem"), "utf8");
	const psql = (args: string[], sql: string) =>
		exec("mise", ["exec", "postgres@18", "--", "psql", ...args, "-tAX", "-c", sql], root, {
			PGCONNECT_TIMEOUT: "5",
		});

	return {
		root,
		env,
		proxyPort,
		ca,
		async project(name, files = {}) {
			const dir = join(root, name);
			await mkdir(dir, { recursive: true });
			for (const [path, content] of Object.entries(files)) {
				await mkdir(dirname(join(dir, path)), { recursive: true });
				await writeFile(join(dir, path), content);
			}
			await mkdir(join(dir, "node_modules"), { recursive: true });
			await symlink(repo, join(dir, "node_modules/basepad"));
			return dir;
		},
		basepad: (cwd, ...args) => exec(process.execPath, [cli, ...args], cwd),
		run: (file, args) => exec(file, args, root),
		psql,
		redis: (url, ...args) =>
			exec("mise", ["exec", "redis@8", "--", "redis-cli", "-u", url, ...args], root, {
				MISE_SKILLS_FETCH: "false",
			}),
		async sql(project, sql) {
			const url = (await readEnv(project, ".env.local")).DATABASE_URL as string;
			return psql([url], sql);
		},
		async get(url) {
			const { hostname, host, port, pathname, search } = new URL(url);
			const pem = await ca();
			return new Promise((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port: port || 443,
						servername: hostname,
						path: `${pathname}${search}`,
						headers: { host },
						ca: pem,
					},
					(res) => {
						let body = "";
						res.setEncoding("utf8").on("data", (chunk: string) => {
							body += chunk;
						});
						res.on("end", () =>
							res.statusCode === 200
								? resolve(JSON.parse(body))
								: reject(
										new Error(
											`${url}: ${res.statusCode} ${body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}`,
										),
									),
						);
					},
				);
				req.setTimeout(10_000, () => req.destroy(new Error(`${url}: timed out`)));
				req.on("error", reject);
				req.end();
			});
		},
		basepadWith: (options, cwd, ...args) => {
			const [file, ...via] = options.via ?? [process.execPath];
			return exec(file as string, [...via, cli, ...args], cwd, options.env, options.input);
		},
		async dispose() {
			// Stop basepad's supervisor and its apps, so nothing outlives the test.
			const home = join(root, "home/pitchfork");
			if (existsSync(join(home, "state/sock"))) {
				const pitchfork = ["exec", `pitchfork@${PITCHFORK_VERSION}`, "--", "pitchfork"];
				const own = {
					PITCHFORK_STATE_DIR: join(home, "state"),
					PITCHFORK_CONFIG_DIR: join(home, "config"),
					PITCHFORK_LOGS_DIR: join(home, "logs"),
					// As in src/tools.ts: a failed skill fetch must not fail the stop.
					MISE_SKILLS_FETCH: "false",
				};
				await exec("mise", [...pitchfork, "stop", "--all"], root, own);
				const stopped = await exec("mise", [...pitchfork, "supervisor", "stop"], root, own);
				// A supervisor left running holds the proxy's port and outlives the test.
				if (stopped.code !== 0) {
					throw new Error(`dispose: the supervisor in ${root} did not stop:\n${stopped.stderr}`);
				}
			}
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** A port nothing listens on right now. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

/** Drops the parent shell's mise activation, so it can't leak config from the developer's cwd. */
function stripMise(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("__MISE")));
}

/** An env file's keys and values, as written unquoted. */
export async function readEnv(dir: string, file: string): Promise<Record<string, string>> {
	const text = await readFile(join(dir, file), "utf8");
	return Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

/** A `basepad.config.ts` exporting `body` through `defineConfig`, with every kind's factory. */
export function configFile(body: string): string {
	return `import { defineConfig, mailpit, postgres, redis } from "basepad";\n\nexport default defineConfig(${body});\n`;
}

/**
 * Sends one message through an `smtp://user:pass@host:port` URL, as an app's mailer would: EHLO,
 * AUTH PLAIN with the URL's credentials, then the message.
 */
export async function sendMail(
	url: string,
	message: { from: string; to: string; subject: string },
): Promise<void> {
	const { hostname, port, username, password } = new URL(url);
	const socket = createConnection({ host: hostname, port: Number(port) });
	socket.setEncoding("utf8");
	let buffer = "";
	const waiting: ((reply: string) => void)[] = [];
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
	const failed = new Promise<never>((_, reject) => socket.on("error", reject));
	// Awaited only while a reply is awaited; an error after the last one is no failure of the send.
	failed.catch(() => {});
	const expectReply = async (code: string) => {
		const got = await Promise.race([
			new Promise<string>((resolve) => waiting.push(resolve)),
			failed,
		]);
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
		const body = [`From: ${message.from}`, `To: ${message.to}`, `Subject: ${message.subject}`, ""];
		await send([...body, "Sent by basepad's tests.", "."].join("\r\n"), "250");
		await send("QUIT", "221");
	} finally {
		socket.destroy();
	}
}
