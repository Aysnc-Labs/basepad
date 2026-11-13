import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { connect } from "node:tls";
import { z } from "zod";
import { interactive, must, shellQuote } from "./internal/exec.ts";
import type { Machine } from "./layout.ts";
import { install } from "./tools.ts";
import { PITCHFORK_VERSION } from "./versions.ts";

/**
 * The supervisor: basepad's own pitchfork, isolated from any other pitchfork on the machine (its
 * config, state and logs live in basepad's home). It runs each environment's daemons and serves
 * those with a port over HTTPS at `<daemon>.<label>.localhost` on the machine's proxy port.
 */

/** One process an environment runs. */
export interface Daemon {
	/** A shell command. */
	run: string;
	/** The folder it runs in. */
	dir: string;
	/** The port it is first offered as `PORT`; a taken one is passed over. Gives it a domain. */
	port?: number;
}

/** A daemon's state, as `status` shows it. */
export type DaemonState = "running" | "starting" | "stopped" | "failed";

export interface Environment {
	/** Its namespace with the supervisor: the project's name. */
	namespace: string;
	/** Its folder: the config's. */
	dir: string;
	/** Where its generated definitions are written, in basepad's home. */
	definitions: string;
	daemons: Record<string, Daemon>;
}

/** What answers on the machine's port 443: basepad's proxy, something else, or nothing. */
export type StandardPort = "proxy" | "other" | "closed";

export interface Supervisor {
	/** The certificate authority basepad's proxy signs with. Exists once the supervisor has run. */
	ca: string;
	/**
	 * Applies basepad's supervisor settings and starts the supervisor when none runs, waiting
	 * briefly for its proxy to listen.
	 */
	serve(): Promise<void>;
	/**
	 * What port 443 reaches, asked from the port itself: basepad's proxy only when the certificate
	 * it serves verifies against basepad's CA (a developer's own pitchfork there is `other`).
	 */
	standardPort(): Promise<StandardPort>;
	/** pitchfork's own plan for trusting the CA and redirecting port 443, one step per line. */
	proxySetupPlan(): Promise<string[]>;
	/** Applies that plan on the user's terminal (`sudo` may ask for a password). Returns its exit code. */
	proxySetup(): Promise<number>;
	/** Adds the CA to the system trust store. Needs root on Linux. Throws with pitchfork's reason. */
	trust(): Promise<void>;
	/**
	 * Applies basepad's supervisor settings, writes the environment's definitions and registers them
	 * against its folder. Idempotent.
	 */
	register(environment: Environment): Promise<void>;
	/**
	 * Starts the named daemons that are not running, then waits up to `waitMs` for each to listen
	 * (when it has a port) or fail, and returns every daemon's state in the namespace.
	 */
	start(namespace: string, names: string[], waitMs: number): Promise<Record<string, DaemonState>>;
	/** Stops every running daemon in the namespace. Deletes nothing. */
	stop(namespace: string): Promise<void>;
	/** Every registered daemon's state in the namespace. */
	status(namespace: string): Promise<Record<string, DaemonState>>;
	/** A daemon's output lines since `since`, the last `lines` of them. */
	logs(namespace: string, name: string, since: Date, lines: number): Promise<string[]>;
	/** The shell command a developer runs to see a daemon's whole log. */
	logsCommand(namespace: string, name: string): string;
}

/**
 * The settings basepad's pitchfork runs with, in its user config (which also holds pitchfork's
 * registry, so basepad sets keys through pitchfork rather than writing the file). The proxy's are
 * read once, at supervisor start.
 */
function settings(machine: Machine): Record<string, string> {
	return {
		// Every daemon basepad runs is waited on by basepad itself, never by a fixed delay.
		"general.ready_delay": "0s",
		// Domains are <daemon>.<name>.localhost; a git worktree must not add its label to them.
		"general.worktree": "false",
		"proxy.enable": "true",
		"proxy.https": "true",
		"proxy.port": String(machine.proxyPort),
		// Name resolution, trust and port-free URLs are `basepad setup`'s, not pitchfork's own.
		"proxy.dns": "false",
		"proxy.sync_hosts": "false",
		"proxy.auto_trust": "false",
		// A stopped app stays stopped until `basepad up`, whatever opens its URL.
		"proxy.auto_start": "false",
	};
}

/** Installs pitchfork through mise and opens basepad's supervisor. Nothing starts until asked. */
export async function openSupervisor(machine: Machine): Promise<Supervisor> {
	const root = join(machine.home, "pitchfork");
	const dirs = {
		PITCHFORK_STATE_DIR: join(root, "state"),
		PITCHFORK_CONFIG_DIR: join(root, "config"),
		PITCHFORK_LOGS_DIR: join(root, "logs"),
	};
	const pitchfork = (await install("pitchfork", PITCHFORK_VERSION, machine.home)).bin("pitchfork");
	const env = supervisorEnv(dirs);
	const run = (...args: string[]) => must(pitchfork, args, { cwd: machine.home, env });

	const running = () => existsSync(join(dirs.PITCHFORK_STATE_DIR, "sock"));
	const ca = join(dirs.PITCHFORK_STATE_DIR, "proxy", "ca.pem");

	/** Sets what differs; a running supervisor restarts to take changed settings (its daemons stop). */
	const applySettings = async () => {
		const current = z
			.array(z.looseObject({ key: z.string(), value: z.string() }))
			.parse(JSON.parse(await run("settings", "--json")));
		const now = new Map(current.map((entry) => [entry.key, entry.value]));
		const changes = Object.entries(settings(machine)).filter(
			([key, value]) => now.get(key) !== value,
		);
		for (const [key, value] of changes) await run("settings", "set", key, value, "--global");
		if (changes.length > 0 && running()) await run("supervisor", "start", "--force");
	};

	/** The namespace's daemons. With no supervisor running there are none, and none is started. */
	const list = async (namespace: string): Promise<Listed[]> => {
		if (!running()) return [];
		return z.array(Listed).parse(JSON.parse(await run("list", "--json", "--namespace", namespace)));
	};

	const states = async (namespace: string) => {
		const out: Record<string, DaemonState> = {};
		for (const daemon of await list(namespace)) out[daemon.name] = await stateOf(daemon);
		return out;
	};

	const serve = async () => {
		await applySettings();
		if (running()) return;
		await run("supervisor", "start");
		// The proxy (and its CA, on a first start) comes up just after the supervisor returns.
		const until = Date.now() + 5000;
		while (!(await listening(machine.proxyPort)) && Date.now() < until) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};

	return {
		ca,
		serve,

		standardPort: () => probeStandardPort(ca),

		async proxySetupPlan() {
			const out = await run("proxy", "setup", "--dry-run");
			return (
				out
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "" && !line.endsWith("following:"))
					// pitchfork lists this step even when the CA exists, and skips it when applying.
					.filter((line) => !(line.startsWith("generate the pitchfork CA") && existsSync(ca)))
			);
		},

		proxySetup: () =>
			interactive(pitchfork, ["proxy", "setup", "--yes"], { cwd: machine.home, env }),

		async trust() {
			await run("proxy", "trust");
		},

		async register({ namespace, dir, definitions, daemons }) {
			await serve();
			const text = toml(daemons);
			if ((await readFile(definitions, "utf8").catch(() => "")) !== text) {
				await mkdir(dirname(definitions), { recursive: true });
				await writeFile(definitions, text);
			}
			await run(
				"config",
				"add",
				definitions,
				"--dir",
				dir,
				"--namespace",
				namespace,
				"--label",
				namespace,
			);
		},

		async start(namespace, names, waitMs) {
			const listed = await list(namespace);
			const idle = names.filter(
				(name) => !listed.some((d) => d.name === name && LIVE.has(d.status)),
			);
			if (idle.length > 0) await run("start", ...idle.map((name) => `${namespace}/${name}`));
			const until = Date.now() + waitMs;
			for (;;) {
				const now = await states(namespace);
				const settled = names.every((name) => now[name] !== "starting");
				if (settled || Date.now() >= until) return now;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		},

		async stop(namespace) {
			const running = (await list(namespace)).filter((d) => LIVE.has(d.status));
			if (running.length > 0) await run("stop", ...running.map((d) => d.id));
		},

		status: states,

		async logs(namespace, name, since, lines) {
			const out = await run(
				"logs",
				`${namespace}/${name}`,
				"-n",
				String(lines),
				"--since",
				localTime(since),
				"--raw",
				"--no-pager",
			);
			return out.split("\n").filter((line) => line !== "");
		},

		logsCommand(namespace, name) {
			return `PITCHFORK_LOGS_DIR=${shellQuote(dirs.PITCHFORK_LOGS_DIR)} mise exec pitchfork@${PITCHFORK_VERSION} -- pitchfork logs ${namespace}/${name}`;
		},
	};
}

/**
 * The environment pitchfork runs in, which its supervisor passes on to every daemon: the caller's,
 * minus any `PITCHFORK_*` setting meant for a developer's own pitchfork, and with the PATH the
 * developer had before the launcher moved basepad onto mise's Node.
 */
function supervisorEnv(dirs: Record<string, string>): NodeJS.ProcessEnv {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("PITCHFORK_")),
	);
	if (env.BASEPAD_PATH) env.PATH = env.BASEPAD_PATH;
	delete env.BASEPAD_PATH;
	return { ...env, ...dirs };
}

/** The name the probe asks the proxy for: any name under `localhost` gets a certificate. */
const PROBE_HOST = "basepad-probe.localhost";

async function probeStandardPort(ca: string): Promise<StandardPort> {
	const pem = await readFile(ca, "utf8").catch(() => undefined);
	return new Promise((resolve) => {
		const socket = connect({
			host: "127.0.0.1",
			port: 443,
			servername: PROBE_HOST,
			ca: pem ?? [],
			rejectUnauthorized: false,
		});
		const done = (answer: StandardPort) => {
			socket.destroy();
			resolve(answer);
		};
		socket.setTimeout(1000, () => done("other"));
		socket.on("secureConnect", () => done(pem && socket.authorized ? "proxy" : "other"));
		socket.on("error", (error: NodeJS.ErrnoException) =>
			done(error.code === "ECONNREFUSED" ? "closed" : "other"),
		);
	});
}

/** One entry of `pitchfork list --json`; only what basepad reads. */
const Listed = z.looseObject({
	id: z.string(),
	name: z.string(),
	status: z.string(),
	active_port: z.number().nullable().optional(),
	port: z.array(z.number()).optional(),
});
type Listed = z.infer<typeof Listed>;

/** pitchfork's statuses of a daemon that is up or on its way up. */
const LIVE = new Set(["running", "waiting", "restarting"]);

/** A daemon with a port is running once something listens there; until then it is starting. */
async function stateOf(daemon: Listed): Promise<DaemonState> {
	if (daemon.status === "running") {
		const port = daemon.active_port ?? undefined;
		if (port === undefined && (daemon.port ?? []).length > 0) return "starting";
		return port === undefined || (await listening(port)) ? "running" : "starting";
	}
	if (LIVE.has(daemon.status)) return "starting";
	if (daemon.status === "errored" || daemon.status === "failed" || daemon.status === "completed") {
		return "failed";
	}
	return "stopped";
}

async function listening(port: number): Promise<boolean> {
	for (const host of ["127.0.0.1", "::1"]) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ host, port });
			socket.setTimeout(500);
			socket.on("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.on("timeout", () => {
				socket.destroy();
				resolve(false);
			});
			socket.on("error", () => resolve(false));
		});
		if (ok) return true;
	}
	return false;
}

/**
 * The definitions file. pitchfork's own `dir` key would make the proxy refuse a daemon that runs
 * outside the registered folder, so each daemon `cd`s into its folder itself.
 */
function toml(daemons: Record<string, Daemon>): string {
	return Object.entries(daemons)
		.map(([name, daemon]) => {
			const lines = [
				`[daemons.${name}]`,
				`run = ${JSON.stringify(`cd ${shellQuote(daemon.dir)} && ${daemon.run}`)}`,
			];
			if (daemon.port !== undefined) {
				lines.push(`port = { expect = [${daemon.port}], bump = true }`);
			}
			return `${lines.join("\n")}\n`;
		})
		.join("\n");
}

/** `YYYY-MM-DD HH:MM:SS` in local time, as `pitchfork logs --since` reads it. */
function localTime(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
