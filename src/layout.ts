import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
	/**
	 * Its namespace with the supervisor: `<name>` for main, `<name>.<suffix>` for a worktree. Every
	 * service runs in main's, on one server per service for all of a project's environments.
	 */
	namespace: string;
	/** Main's namespace, `<name>`, where every service runs. */
	mainNamespace: string;
	/** A worktree's suffix; absent in main. */
	suffix?: string;
}

/** One service's place in the environment, with the names its kind derives. */
export type ServicePlace = {
	/** The port the service is first tried on; the next free one is used when it is taken. */
	port: number;
	/** The service's data folder in the home. */
	dir: string;
	/** Its daemon with the supervisor, `<name>/<key>` in main's namespace: what an app depends on. */
	daemon: string;
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

/**
 * The worktree suffix a layout is checked against at load, so a name that leaves too little room
 * fails before any worktree is made: the prefix with a three-digit number.
 */
const LONGEST_NUMBER = 999;

/**
 * Main's layout, or with `suffix` a worktree's. Main's also checks that a worktree's names will
 * fit, with the longest suffix the prefix makes.
 */
export function layout(
	project: Pick<Project, "file" | "name" | "apps" | "services"> & {
		worktrees: Pick<Project["worktrees"], "prefix">;
	},
	machine: Machine,
	suffix?: string,
): Layout {
	const fail = (reason: string): never => {
		throw new BasepadError(`${project.file}: ${reason}`);
	};
	const { name } = project;
	if (name.length > LABEL_MAX) {
		fail(`\`name\` is ${name.length} characters; a domain label allows ${LABEL_MAX}.`);
	}
	if (suffix !== undefined && suffix.length > LABEL_MAX) {
		fail(`the worktree suffix is ${suffix.length} characters; a domain label allows ${LABEL_MAX}.`);
	}
	const apps: Layout["apps"] = {};
	const block = APP_PORT_BASE + (hash(name) % APP_PORT_BLOCKS) * APP_PORT_BLOCK;
	for (const [i, key] of Object.keys(project.apps).entries()) {
		if (key.length > LABEL_MAX) {
			fail(`app \`${key}\` is ${key.length} characters; a domain label allows ${LABEL_MAX}.`);
		}
		const host = appHost(key, name, suffix);
		const port = machine.portFree ? "" : `:${machine.proxyPort}`;
		apps[key] = { host, url: `https://${host}${port}`, port: block + (i % APP_PORT_BLOCK) };
	}
	const services: Layout["services"] = {};
	for (const [key, service] of Object.entries(project.services)) {
		const dir = join(servicesHome(machine, name), key);
		let names: NamesOf<Service>;
		try {
			names = kindOf(service).names(service, { name, key, dir, suffix });
		} catch (error) {
			if (error instanceof BasepadError) fail(error.message);
			throw error;
		}
		services[key] = {
			...names,
			port: SERVICE_PORT_BASE + (hash(`${name}.${key}`) % SERVICE_PORTS),
			dir,
			daemon: daemonId(name, key),
		};
	}
	// Last, so a name main itself cannot have is reported in main's words.
	if (suffix === undefined) {
		const longest = `${project.worktrees.prefix}-${LONGEST_NUMBER}`;
		try {
			layout(project, machine, longest);
		} catch (error) {
			if (!(error instanceof BasepadError) || !error.message.startsWith(`${project.file}: `)) {
				throw error;
			}
			const reason = error.message.slice(project.file.length + 2);
			const shorten = reason.startsWith("the worktree suffix")
				? "Shorten `worktrees.prefix`."
				: "Shorten `name`, the service key or `worktrees.prefix`.";
			fail(`worktree suffixes like "${longest}" leave too little room: ${reason} ${shorten}`);
		}
	}
	const namespace = namespaceOf(name, suffix);
	return {
		apps,
		services,
		definitions: definitionsFile(machine, namespace),
		namespace,
		mainNamespace: name,
		...(suffix === undefined ? {} : { suffix }),
	};
}

/**
 * An app's domain: `<app>.<name>.localhost` in main, `<app>.<suffix>.<name>.localhost` in a
 * worktree, as the supervisor's proxy serves it.
 */
export function appHost(app: string, name: string, suffix?: string): string {
	return suffix === undefined ? `${app}.${name}.localhost` : `${app}.${suffix}.${name}.localhost`;
}

/**
 * An environment's namespace with the supervisor: `<name>` for main, `<name>.<suffix>` for a
 * worktree. Unchecked, so what basepad made for a worktree is found whatever its names' limits.
 */
export function namespaceOf(name: string, suffix?: string): string {
	return suffix === undefined ? name : `${name}.${suffix}`;
}

/** The file in basepad's home holding a namespace's supervisor definitions. */
export function definitionsFile(machine: Pick<Machine, "home">, namespace: string): string {
	return join(machine.home, "environments", `${namespace}.toml`);
}

/** A daemon's id with the supervisor: `<namespace>/<name>`. */
export function daemonId(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}

/** The suffix of `namespace` when it is a worktree's of the project `name`; else none. */
export function suffixOf(name: string, namespace: string): string | undefined {
	return namespace.startsWith(`${name}.`) ? namespace.slice(name.length + 1) : undefined;
}

/**
 * The folder worktrees are checked out in: `worktrees.dir`, else `<name>.worktrees` beside the
 * repository's top folder `top`. With `suffix`, that worktree's own folder in it.
 */
export function worktreeFolder(
	project: Pick<Project, "name"> & { worktrees: Pick<Project["worktrees"], "dir"> },
	top: string,
	suffix?: string,
): string {
	const dir = project.worktrees.dir ?? join(dirname(top), `${project.name}.worktrees`);
	return suffix === undefined ? dir : join(dir, suffix);
}

/** A new worktree's suffix: `<prefix>-<n>` with the lowest `n` from 1 that no name in `taken` has. */
export function nextSuffix(prefix: string, taken: Iterable<string>): string {
	const names = new Set(taken);
	let n = 1;
	while (names.has(`${prefix}-${n}`)) n++;
	return `${prefix}-${n}`;
}

/** The folder in basepad's home holding a project's services, one folder per service key. */
export function servicesHome(machine: Pick<Machine, "home">, name: string): string {
	return join(machine.home, "services", name);
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
