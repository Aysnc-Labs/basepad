import { homedir } from "node:os";
import { join } from "node:path";
import type { Project } from "./config.ts";
import { BasepadError } from "./internal/exec.ts";

/** The machine's facts every layout depends on, read once from the environment. */
export interface Machine {
	/** basepad's home: generated definitions and the supervisor's state, nothing else. */
	home: string;
	/** The port basepad's HTTPS proxy listens on; app URLs carry it unless it is 443. */
	proxyPort: number;
}

/** The proxy's default port: high, so it needs no privilege, and unlike pitchfork's own suggestion. */
const PROXY_PORT = 7443;

/** Reads `BASEPAD_HOME` (default `~/.basepad`) and `BASEPAD_PROXY_PORT` (default 7443). */
export function machine(env: NodeJS.ProcessEnv): Machine {
	const raw = env.BASEPAD_PROXY_PORT;
	const proxyPort = raw === undefined || raw === "" ? PROXY_PORT : Number(raw);
	if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
		throw new BasepadError(`BASEPAD_PROXY_PORT must be a port number; got \`${raw}\`.`);
	}
	return { home: env.BASEPAD_HOME || join(env.HOME || homedir(), ".basepad"), proxyPort };
}

/**
 * Every fact derived from the project's description and the machine: domains, URLs, starting ports,
 * database names and paths in basepad's home. The only place such names are computed. It rejects
 * names past their limits with the reason, and never truncates.
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
	services: Record<
		string,
		{
			database: string;
			/** The port the service is first tried on; the next free one is used when it is taken. */
			port: number;
			/** The service's data folder in the home. */
			dir: string;
		}
	>;
	/** The environment's supervisor definitions, generated into the home. */
	definitions: string;
}

/** A DNS label's limit, in characters. */
const LABEL_MAX = 63;
/** Postgres silently truncates identifiers past this many bytes. */
const IDENTIFIER_MAX = 63;

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
		const host = `${key}.${name}.localhost`;
		const port = machine.proxyPort === 443 ? "" : `:${machine.proxyPort}`;
		apps[key] = { host, url: `https://${host}${port}`, port: block + (i % APP_PORT_BLOCK) };
	}
	const services: Layout["services"] = {};
	for (const key of Object.keys(project.services)) {
		const database = `${name}_${key}`.replaceAll("-", "_");
		const bytes = Buffer.byteLength(database);
		if (bytes > IDENTIFIER_MAX) {
			fail(
				`\`name\` and service \`${key}\` make the database name "${database}", which is ${bytes} bytes; Postgres allows ${IDENTIFIER_MAX}. Shorten \`name\` or the service key.`,
			);
		}
		services[key] = {
			database,
			port: SERVICE_PORT_BASE + (hash(`${name}.${key}`) % SERVICE_PORTS),
			dir: join(machine.home, "services", name, key),
		};
	}
	return { apps, services, definitions: join(machine.home, "environments", `${name}.toml`) };
}

/** FNV-1a: a stable spread of names over port blocks. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (const byte of Buffer.from(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
	return h;
}
