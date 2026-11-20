import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createConnection, createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";
import { shellQuote } from "../src/internal/exec.ts";
import { PITCHFORK_VERSION } from "../src/versions.ts";
import { PROJECT_MISE_TOML } from "./mise-tools.ts";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const cli = join(repo, "dist/launcher.js");

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

export interface Sandbox {
	root: string;
	toolsDir: string;
	env: NodeJS.ProcessEnv;
	proxyPort: number;
	ca(): Promise<string>;
	project(name: string, files?: Record<string, string>): Promise<string>;
	basepad(cwd: string, ...args: string[]): Promise<Result>;
	run(file: string, args: string[]): Promise<Result>;
	psql(args: string[], sql: string): Promise<Result>;
	redis(url: string, ...args: string[]): Promise<Result>;
	sql(project: string, sql: string): Promise<Result>;
	get<T = unknown>(url: string): Promise<T>;
	getOnceRouted<T = unknown>(url: string, withinMs?: number): Promise<T>;
	onTerminal(cwd: string, input: string, ...args: string[]): Promise<Result>;
	basepadWith(
		options: { env?: NodeJS.ProcessEnv; via?: string[]; input?: string },
		cwd: string,
		...args: string[]
	): Promise<Result>;
	dispose(): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
	// Short and real (macOS's tmpdir is a symlink): unix socket paths have a ~104-byte limit:
	// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h#L79
	const root = await realpath(
		await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bp-")),
	);
	const env: NodeJS.ProcessEnv = {
		...stripMise(process.env),
		BASEPAD_HOME: join(root, "home"),
		MISE_STATE_DIR: join(root, "mise-state"),
		MISE_CONFIG_DIR: join(root, "mise-config"),
		MISE_DATA_DIR: inject("miseDataDir"),
		MISE_CACHE_DIR: inject("miseCacheDir"),
		MISE_TRUSTED_CONFIG_PATHS: root,
		PITCHFORK_STATE_DIR: join(root, "pf-state"),
		PITCHFORK_CONFIG_DIR: join(root, "pf-config"),
		PITCHFORK_LOGS_DIR: join(root, "pf-logs"),
		NO_COLOR: "1",
	};
	const toolsDir = join(root, ".tools");
	await mkdir(toolsDir);
	await writeFile(join(toolsDir, "mise.toml"), MISE_TOML);
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
			if (e.signal) {
				return { code: shellStatus(e.signal), stdout, stderr: `${stderr}[killed by ${e.signal}]` };
			}
			return { code: e.code ?? 1, stdout, stderr };
		}
	};

	const ca = () => readFile(join(root, "home/pitchfork/state/proxy/ca.pem"), "utf8");
	const psql = (args: string[], sql: string) =>
		exec("mise", ["exec", "postgres@18", "--", "psql", ...args, "-tAX", "-c", sql], toolsDir, {
			PGCONNECT_TIMEOUT: "5",
		});

	const box: Sandbox = {
		root,
		toolsDir,
		env,
		proxyPort,
		ca,
		async project(name, files = {}) {
			const dir = join(root, name);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "mise.toml"), MISE_TOML);
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
			exec("mise", ["exec", "redis@8", "--", "redis-cli", "-u", url, ...args], toolsDir, {
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
		async getOnceRouted<T>(url: string, withinMs = 10_000): Promise<T> {
			for (const until = Date.now() + withinMs; ; ) {
				try {
					return await box.get<T>(url);
				} catch (error) {
					if (Date.now() > until) throw error;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}
		},
		onTerminal(cwd, input, ...args) {
			const command = [process.execPath, cli, ...args].map(shellQuote).join(" ");
			const shell = `cd ${shellQuote(cwd)} && ${command}`;
			const [file, argv] =
				process.platform === "darwin"
					? [
							"python3",
							["-c", "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)", "sh", "-c", shell],
						]
					: ["script", ["-qec", shell, "/dev/null"]];
			return new Promise((resolve) => {
				const child = execFile(file, argv, { env }, (error, stdout, stderr) =>
					resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
				);
				let typed = false;
				child.stdout?.on("data", (chunk: Buffer) => {
					if (typed || !chunk.toString().includes("[y/N]")) return;
					typed = true;
					child.stdin?.write(input);
				});
			});
		},
		basepadWith: (options, cwd, ...args) => {
			const [file, ...via] = options.via ?? [process.execPath];
			return exec(file as string, [...via, cli, ...args], cwd, options.env, options.input);
		},
		async dispose() {
			const home = join(root, "home/pitchfork");
			if (existsSync(join(home, "state/sock"))) {
				const pitchfork = ["exec", `pitchfork@${PITCHFORK_VERSION}`, "--", "pitchfork"];
				const own = {
					PITCHFORK_STATE_DIR: join(home, "state"),
					PITCHFORK_CONFIG_DIR: join(home, "config"),
					PITCHFORK_LOGS_DIR: join(home, "logs"),
					MISE_SKILLS_FETCH: "false",
				};
				await exec("mise", [...pitchfork, "stop", "--all"], root, own);
				const stopped = await exec("mise", [...pitchfork, "supervisor", "stop"], root, own);
				if (stopped.code !== 0) {
					throw new Error(`dispose: the supervisor in ${root} did not stop:\n${stopped.stderr}`);
				}
			}
			await rm(root, { recursive: true, force: true });
		},
	};
	return box;
}

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

function stripMise(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("__MISE")));
}

export async function readEnv(dir: string, file: string): Promise<Record<string, string>> {
	const text = await readFile(join(dir, file), "utf8");
	return Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

export const MISE_TOML = readFileSync(PROJECT_MISE_TOML, "utf8");

export function configFile(body: string): string {
	return `import { defineConfig, mailpit, postgres, postgresWithNeonProxy, redis } from "basepad";\n\nexport default defineConfig(${body});\n`;
}

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
		// A reply ends with a line whose code is followed by a space: "250 OK", not "250-AUTH":
		// https://www.rfc-editor.org/rfc/rfc5321#section-4.2
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

function shellStatus(signal: NodeJS.Signals): number {
	return 128 + (constants.signals[signal] ?? 0);
}
