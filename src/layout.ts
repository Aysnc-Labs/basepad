import { dirname, join, normalize, sep } from "node:path";
import {
	EXTRA_DAEMONS,
	type ExtraDaemon,
	type Kind,
	kindOf,
	type NamesOf,
	type Place,
	type Service,
	type Web,
} from "./catalogue.ts";
import type { Project } from "./config.ts";
import { basepadHome } from "./home.ts";
import { BasepadError } from "./internal/exec.ts";

export interface Machine {
	home: string;
	proxyPort: number;
	portFree: boolean;
	forwards443: boolean;
}

const PROXY_PORT = 7443;

export function machine(
	env: NodeJS.ProcessEnv,
	rootOnLinux = isRootOnLinux(),
	platform = process.platform,
): Machine {
	const raw = env.BASEPAD_PROXY_PORT;
	const unset = raw === undefined || raw === "";
	const proxyPort = unset ? (rootOnLinux ? 443 : PROXY_PORT) : Number(raw);
	if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
		throw new BasepadError(`BASEPAD_PROXY_PORT must be a port number; got \`${raw}\`.`);
	}
	return {
		home: basepadHome(env),
		proxyPort,
		portFree: proxyPort === 443,
		forwards443: unset && platform === "darwin",
	};
}

export function isRootOnLinux(): boolean {
	return process.platform === "linux" && process.getuid?.() === 0;
}

export interface Layout {
	apps: Record<
		string,
		{
			host?: string;
			url?: string;
			port?: number;
		}
	>;
	services: Record<string, ServicePlace>;
	definitions: string;
	namespace: string;
	mainNamespace: string;
	suffix?: string;
}

export type ServicePlace = {
	port: number;
	dir: string;
	daemon: string;
	extraDaemons: Record<string, ExtraDaemon>;
	web?: Web;
} & NamesOf<Service>;

type KindOf = (
	service: Service,
) => Pick<
	Kind<Service, unknown, NamesOf<Service>>,
	"names" | "web" | "perEnvironment" | "extraDaemons"
>;

/** A DNS label's limit, in characters: https://www.rfc-editor.org/rfc/rfc1035#section-2.3.4 */
const LABEL_MAX = 63;

const SERVICE_PORT_BASE = 15000;
const APP_PORT_BASE = 20000;
const APP_PORT_END = 32000;
const APP_PORT_BLOCK = 20;
const APP_PORT_BLOCKS = (APP_PORT_END - APP_PORT_BASE) / APP_PORT_BLOCK;
const SERVICE_PORTS = APP_PORT_BASE - SERVICE_PORT_BASE;

const LONGEST_NUMBER = 999;

export function layout(
	project: Pick<Project, "file" | "name" | "apps" | "services"> & {
		worktrees: Pick<Project["worktrees"], "prefix">;
	},
	machine: Machine,
	suffix?: string,
	kinds: KindOf = kindOf,
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
	const urlOf = (host: string) =>
		`https://${host}${machine.portFree ? "" : `:${machine.proxyPort}`}`;
	const apps: Layout["apps"] = {};
	const block = APP_PORT_BASE + (fnv1a(name) % APP_PORT_BLOCKS) * APP_PORT_BLOCK;
	for (const [i, [key, app]] of Object.entries(project.apps).entries()) {
		if (app.port === false) {
			apps[key] = {};
			continue;
		}
		if (key.length > LABEL_MAX) {
			fail(`app \`${key}\` is ${key.length} characters; a domain label allows ${LABEL_MAX}.`);
		}
		const port = block + (i % APP_PORT_BLOCK);
		if (app.domain === false) {
			apps[key] = { port };
			continue;
		}
		const host = appHost(key, name, suffix);
		apps[key] = { host, url: urlOf(host), port };
	}
	const namespace = namespaceOf(name, suffix);
	const services: Layout["services"] = {};
	for (const [key, service] of Object.entries(project.services)) {
		const dir = join(servicesHome(machine, name), key);
		const kind = kinds(service);
		let names: NamesOf<Service>;
		try {
			names = kind.names(service, { name, key, dir, suffix });
		} catch (error) {
			if (error instanceof BasepadError) fail(error.message);
			throw error;
		}
		const web = kind.web === true;
		const host = appHost(key, name);
		if (web && key in project.apps) {
			fail(
				`service \`${key}\` is served at ${host}, which is app \`${key}\`'s domain. Rename one.`,
			);
		}
		const runsIn = kind.perEnvironment?.(service) ? namespace : name;
		const extraDaemons: Record<string, ExtraDaemon> = {};
		for (const extra of kind.extraDaemons ?? []) {
			const daemon = extraDaemonName(key, extra);
			if (daemon in project.apps || daemon in project.services) {
				fail(
					`service \`${key}\` runs a daemon named \`${daemon}\`, which is ${daemon in project.apps ? "app" : "service"} \`${daemon}\`'s name. Rename one.`,
				);
			}
			extraDaemons[extra] = {
				daemon: daemonId(runsIn, daemon),
				port: servicePort(`${runsIn}.${key}.${extra}`),
				pid: join(dir, `${extra}.pid`),
			};
		}
		services[key] = {
			...names,
			port: servicePort(`${runsIn}.${key}`),
			dir,
			daemon: daemonId(runsIn, key),
			extraDaemons,
			...(web ? { web: { host, url: urlOf(host), port: servicePort(`${name}.${key}.web`) } } : {}),
		};
	}
	if (suffix === undefined) {
		const longest = `${project.worktrees.prefix}-${LONGEST_NUMBER}`;
		try {
			layout(project, machine, longest, kinds);
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
	return {
		apps,
		services,
		definitions: definitionsFile(machine, namespace),
		namespace,
		mainNamespace: name,
		...(suffix === undefined ? {} : { suffix }),
	};
}

export function placeOf(
	project: Pick<Project, "name" | "root">,
	lay: Layout,
	machine: Machine,
	key: string,
	mainRoot = project.root,
): Place<NamesOf<Service>> {
	const service = lay.services[key] as ServicePlace;
	const suffix = lay.suffix === undefined ? {} : { suffix: lay.suffix };
	const inMain = ofDaemon(service.daemon).namespace === lay.mainNamespace;
	const programsCheckout = inMain ? mainRoot : project.root;
	return {
		name: project.name,
		key,
		owner: project.root,
		programsCheckout,
		machine,
		...suffix,
		...service,
	};
}

export function ownServers(lay: Pick<Layout, "namespace" | "services">): string[] {
	return Object.entries(lay.services)
		.filter(([, place]) => ofDaemon(place.daemon).namespace === lay.namespace)
		.map(([key]) => key);
}

function extraDaemonName(key: string, extra: string): string {
	return `${key}-${extra}`;
}

export function extraDaemonNames(keys: string[]): string[] {
	return keys.flatMap((key) => EXTRA_DAEMONS.map((extra) => extraDaemonName(key, extra)));
}

export function daemonsOf(place: Pick<ServicePlace, "daemon" | "extraDaemons">): string[] {
	return [place.daemon, ...Object.values(place.extraDaemons).map((extra) => extra.daemon)];
}

export function appHost(app: string, name: string, suffix?: string): string {
	return suffix === undefined ? `${app}.${name}.localhost` : `${app}.${suffix}.${name}.localhost`;
}

export function namespaceOf(name: string, suffix?: string): string {
	return suffix === undefined ? name : `${name}.${suffix}`;
}

export function definitionsFile(machine: Pick<Machine, "home">, namespace: string): string {
	return join(machine.home, "environments", `${namespace}.toml`);
}

export function daemonId(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}

export function ofDaemon(id: string): { namespace: string; name: string } {
	const slash = id.lastIndexOf("/");
	return { namespace: id.slice(0, slash), name: id.slice(slash + 1) };
}

export function suffixOf(name: string, namespace: string): string | undefined {
	return namespace.startsWith(`${name}.`) ? namespace.slice(name.length + 1) : undefined;
}

export function worktreeSuffix(root: string, configDir = ""): string {
	const segments = (path: string) =>
		normalize(path)
			.split(sep)
			.filter((s) => s !== "" && s !== ".");
	const folders = segments(root);
	return folders[folders.length - 1 - segments(configDir).length] ?? "";
}

export function worktreeFolder(
	project: Pick<Project, "name"> & { worktrees: Pick<Project["worktrees"], "dir"> },
	top: string,
	suffix?: string,
): string {
	const dir = project.worktrees.dir ?? join(dirname(top), `${project.name}.worktrees`);
	return suffix === undefined ? dir : join(dir, suffix);
}

export function nextSuffix(prefix: string, taken: Iterable<string>): string {
	const names = new Set(taken);
	let n = 1;
	while (names.has(`${prefix}-${n}`)) n++;
	return `${prefix}-${n}`;
}

export function servicesHome(machine: Pick<Machine, "home">, name: string): string {
	return join(machine.home, "services", name);
}

export function workHome(machine: Pick<Machine, "home">, name: string): string {
	return join(machine.home, "work", name);
}

export function supervisorPaths(machine: Pick<Machine, "home">): {
	state: string;
	config: string;
	logs: string;
	ca: string;
	caKey: string;
} {
	const root = join(machine.home, "pitchfork");
	const state = join(root, "state");
	return {
		state,
		config: join(root, "config"),
		logs: join(root, "logs"),
		ca: join(state, "proxy", "ca.pem"),
		caKey: join(state, "proxy", "ca-key.pem"),
	};
}

function servicePort(seed: string): number {
	return SERVICE_PORT_BASE + (fnv1a(seed) % SERVICE_PORTS);
}

export function localhostCertificate(machine: Pick<Machine, "home">): {
	cert: string;
	key: string;
} {
	const dir = join(machine.home, "tls");
	return { cert: join(dir, "localhost.pem"), key: join(dir, "localhost-key.pem") };
}

function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (const byte of Buffer.from(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
	return h;
}
