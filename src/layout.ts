import { homedir } from "node:os";
import { join } from "node:path";
import { kindOf, type NamesOf, type Service } from "./catalogue.ts";
import type { Project } from "./config.ts";
import { BasepadError } from "./internal/exec.ts";

/** The machine's facts every layout depends on, read once from the environment. */
export interface Machine {
	/** basepad's home: generated definitions and the supervisor's state, nothing else. */
	home: string;
	/** The port basepad's HTTPS proxy listens on. */
	proxyPort: number;
	/**
	 * Whether port 443 reaches the proxy, so app URLs carry no port: the proxy listens there, or
	 * `basepad setup` redirected it. Asked from the machine (`Supervisor.standardPort`), never stored.
	 */
	portFree: boolean;
}

/** The proxy's default port: high, so it needs no privilege, and unlike pitchfork's own suggestion. */
const PROXY_PORT = 7443;

/**
 * Reads `BASEPAD_HOME` (default `~/.basepad`) and `BASEPAD_PROXY_PORT` (default 7443, or 443 as root
 * on Linux, where the proxy binds it itself). `portFree` starts as what the port alone tells.
 */
export function machine(env: NodeJS.ProcessEnv, rootOnLinux = isRootOnLinux()): Machine {
	const raw = env.BASEPAD_PROXY_PORT;
	const unset = raw === undefined || raw === "";
	const proxyPort = unset ? (rootOnLinux ? 443 : PROXY_PORT) : Number(raw);
	if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
		throw new BasepadError(`BASEPAD_PROXY_PORT must be a port number; got \`${raw}\`.`);
	}
	return {
		home: env.BASEPAD_HOME || join(env.HOME || homedir(), ".basepad"),
		proxyPort,
		portFree: proxyPort === 443,
	};
}

/** Root on Linux needs no prompt for anything machine setup does: `up` does it itself. */
export function isRootOnLinux(): boolean {
	return process.platform === "linux" && process.getuid?.() === 0;
}

/**
 * Every fact derived from the project's description and the machine: domains, URLs, starting ports,
 * paths in basepad's home, and each service kind's names (computed by its kind in the catalogue).
 * The only place such names are computed. It rejects names past their limits with the reason, and
 * never truncates.
 */
export interface Layout {
	apps: Record<
		string,
		{
			host: string;
			/** What `env` sees. The one place the URL form is decided. */
			url: string;
			/** The port the app is first offered as `PORT`; the supervisor moves past a taken one. */
			port: number;
		}
	>;
	/** Each service's port and folder, with the names its kind derives. */
	services: Record<string, ServicePlace>;
	/** The environment's supervisor definitions, generated into the home. */
	definitions: string;
}

/** One service's place in the environment, with the names its kind derives. */
export type ServicePlace = {
	/** The port the service is first tried on; the next free one is used when it is taken. */
	port: number;
	/** The service's data folder in the home. */
	dir: string;
} & NamesOf<Service>;

/** A DNS label's limit, in characters. */
const LABEL_MAX = 63;

/** App ports start in [20000, 32000): clear of common dev ports and of Linux's ephemeral range. */
const APP_PORT_BASE = 20000;
/** Each project gets a block of this many starting ports, chosen by its name. */
const APP_PORT_BLOCK = 20;
const APP_PORT_BLOCKS = 600;
/** Service ports are in [15000, 20000): below the apps', clear of common dev ports. */
const SERVICE_PORT_BASE = 15000;
const SERVICE_PORTS = 5000;

export function layout(
	project: Pick<Project, "file" | "name" | "apps" | "services">,
	machine: Machine,
): Layout {
	const fail = (reason: string): never => {
		throw new BasepadError(`${project.file}: ${reason}`);
	};
	const { name } = project;
	if (name.length > LABEL_MAX) {
		fail(`\`name\` is ${name.length} characters; a domain label allows ${LABEL_MAX}.`);
	}
	const apps: Layout["apps"] = {};
	const block = APP_PORT_BASE + (hash(name) % APP_PORT_BLOCKS) * APP_PORT_BLOCK;
	for (const [i, key] of Object.keys(project.apps).entries()) {
		if (key.length > LABEL_MAX) {
			fail(`app \`${key}\` is ${key.length} characters; a domain label allows ${LABEL_MAX}.`);
		}
		const host = appHost(key, name);
		const port = machine.portFree ? "" : `:${machine.proxyPort}`;
		apps[key] = { host, url: `https://${host}${port}`, port: block + (i % APP_PORT_BLOCK) };
	}
	const services: Layout["services"] = {};
	for (const [key, service] of Object.entries(project.services)) {
		const dir = join(machine.home, "services", name, key);
		let names: NamesOf<Service>;
		try {
			names = kindOf(service).names({ name, key, dir });
		} catch (error) {
			if (error instanceof BasepadError) fail(error.message);
			throw error;
		}
		services[key] = {
			...names,
			port: SERVICE_PORT_BASE + (hash(`${name}.${key}`) % SERVICE_PORTS),
			dir,
		};
	}
	return { apps, services, definitions: join(machine.home, "environments", `${name}.toml`) };
}

/** An app's domain: `<app>.<name>.localhost`, as the supervisor's proxy serves it. */
export function appHost(app: string, name: string): string {
	return `${app}.${name}.localhost`;
}

/** basepad's own pitchfork's folders in the home, and the CA its proxy signs with. */
export function supervisorPaths(machine: Pick<Machine, "home">): {
	state: string;
	config: string;
	logs: string;
	ca: string;
} {
	const root = join(machine.home, "pitchfork");
	const state = join(root, "state");
	return {
		state,
		config: join(root, "config"),
		logs: join(root, "logs"),
		ca: join(state, "proxy", "ca.pem"),
	};
}

/** FNV-1a: a stable spread of names over port blocks. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (const byte of Buffer.from(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
	return h;
}
