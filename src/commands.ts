import { join } from "node:path";
import { z } from "zod";
import { kindOf, type NamesOf, type Place, type Service } from "./catalogue.ts";
import { CONFIG_FILE, loadProject, type Project } from "./config.ts";
import { writeEnvFiles } from "./env-files.ts";
import { syncHosts } from "./hosts.ts";
import type { EnvFiles } from "./index.ts";
import { init } from "./init.ts";
import { BasepadError, shellQuote } from "./internal/exec.ts";
import { Stopped } from "./internal/ports.ts";
import { table } from "./internal/table.ts";
import {
	isRootOnLinux,
	type Layout,
	layout,
	type Machine,
	machine,
	type ServicePlace,
} from "./layout.ts";
import { setup, trustAsRoot } from "./setup.ts";
import { type Daemon, type DaemonState, openSupervisor, type Supervisor } from "./supervisor.ts";

export interface Flag {
	short?: string;
	description: string;
}

export interface Invocation {
	cwd: string;
	/** The flags given, by long name. Every flag is a switch. */
	flags: Record<string, boolean>;
	/** Prints one line of the command's output. */
	print(line: string): void;
}

/** One `basepad` command. The CLI dispatches from, and generates help from, `COMMANDS`. */
export interface Command {
	summary: string;
	flags: Record<string, Flag>;
	run(invocation: Invocation): Promise<void>;
}

export const COMMANDS: Record<string, Command> = {
	init: {
		summary: `Write a starter ${CONFIG_FILE} in this folder`,
		flags: {},
		run: init,
	},
	setup: {
		summary: "Once per machine: trust basepad's certificate and drop the port from URLs",
		flags: {
			"dry-run": { description: "Print the plan and change nothing" },
			yes: { short: "y", description: "Apply the plan without asking" },
		},
		run: setup,
	},
	up: {
		summary: "Start this project's services and apps, set its env files and show their state",
		flags: {
			detach: { short: "d", description: "Accepted for Docker habits; `up` always returns" },
			claim: {
				description:
					"Make this folder the owner of the project's databases, which another checkout under the same name holds",
			},
		},
		run: up,
	},
	down: {
		summary: "Stop this project's apps and services; nothing is deleted",
		flags: {},
		run: down,
	},
	status: {
		summary: "Show each app and service with its address and state",
		flags: {},
		run: status,
	},
};

/** How long `up` waits for apps to listen or fail before it shows their state and returns. */
const APP_WAIT_MS = 5000;
/** How many of a failed app's last lines `up` shows. */
const FAILED_LINES = 20;

async function up({ cwd, flags, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const here = machine(process.env);
	// Ports, folders and databases; the URL form waits for the supervisor, which answers on 443.
	const ports = layout(project, here);
	const services = Object.keys(project.services);
	const apps = Object.keys(project.apps);
	const supervisor = await openSupervisor(here, print);
	const owner = await supervisor.owner(project.name);
	if (owner !== undefined && owner !== project.root && flags.claim !== true) {
		throw new BasepadError(
			`"${project.name}" is the name of the checkout at ${owner}. Two checkouts under one name would share its databases and domains, so basepad stops here.\nIf that checkout moved here, or this one should take over, run \`basepad up --claim\`.`,
		);
	}
	const daemons: Record<string, Daemon> = {};
	for (const key of services) {
		const service = project.services[key] as Service;
		daemons[key] = await kindOf(service).prepare(service, placeOf(project, ports, here, key));
	}
	for (const [key, app] of Object.entries(project.apps)) {
		daemons[key] = {
			run: withLocalBins(project, app.cwd, app.run),
			dir: app.cwd,
			port: ports.apps[key]?.port,
		};
	}
	await supervisor.register({
		namespace: project.name,
		dir: project.root,
		definitions: ports.definitions,
		daemons,
	});
	if (isRootOnLinux()) for (const line of await trustAsRoot(supervisor)) print(line);
	const lay = layout(project, await machineWithPortFree(here, supervisor));
	for (const line of await syncHosts(
		project.name,
		Object.values(lay.apps).map((a) => a.host),
	)) {
		print(line);
	}
	const since = new Date(Date.now() - 1000);
	const outputs: Record<string, unknown> = {};
	if (services.length > 0) {
		const states = await supervisor.start(project.name, services, APP_WAIT_MS);
		const failed = services.filter((key) => states[key] === "failed");
		if (failed.length > 0)
			throw new BasepadError(await failures(supervisor, project, failed, since));
		for (const key of services) {
			const service = project.services[key] as Service;
			try {
				outputs[key] = await kindOf(service).provision(service, placeOf(project, lay, here, key), {
					claim: flags.claim === true,
					stopped: async () => {
						const state = (await supervisor.status(project.name))[key];
						return state === "failed" || state === "stopped";
					},
				});
			} catch (error) {
				if (!(error instanceof Stopped)) throw error;
				throw new BasepadError(await failures(supervisor, project, [key], since));
			}
		}
	}
	for (const [key, app] of Object.entries(lay.apps)) outputs[key] = { url: app.url };
	await writeEnvFiles(project.root, envFiles(project, outputs));
	const states = await supervisor.start(project.name, apps, APP_WAIT_MS);
	print(await stateTables(project, lay, here, states));
	const failed = apps.filter((key) => states[key] === "failed");
	if (failed.length > 0) throw new BasepadError(await failures(supervisor, project, failed, since));
}

/** The machine with `portFree` asked from its port 443, once the supervisor runs. */
async function machineWithPortFree(here: Machine, supervisor: Supervisor): Promise<Machine> {
	return { ...here, portFree: (await supervisor.standardPort()) === "proxy" };
}

/** Where one of the project's services lives. */
function placeOf(
	project: Project,
	lay: Layout,
	here: Machine,
	key: string,
): Place<NamesOf<Service>> {
	const service = lay.services[key] as ServicePlace;
	return { name: project.name, key, owner: project.root, machine: here, ...service };
}

/** Runs the config's `env` with each service's and app's outputs, and checks what it returns. */
function envFiles(project: Project, outputs: Record<string, unknown>): EnvFiles {
	let files: unknown;
	try {
		files = project.env(outputs as Parameters<Project["env"]>[0]);
	} catch (error) {
		throw new BasepadError(`${project.file}: \`env\` threw: ${(error as Error)?.message ?? error}`);
	}
	const result = EnvFilesSchema.safeParse(files);
	if (!result.success) {
		throw new BasepadError(
			`${project.file}: \`env\` must return env file paths, each to keys with string or number values.`,
		);
	}
	return result.data;
}

const EnvFilesSchema = z.record(
	z.string(),
	z.record(z.string(), z.union([z.string(), z.number()])),
);

/** Runs an app's command with its own and the project's `node_modules/.bin` first, as npm does. */
function withLocalBins(project: Project, dir: string, run: string): string {
	const bins = [
		...new Set([join(dir, "node_modules/.bin"), join(project.root, "node_modules/.bin")]),
	];
	return `export PATH=${bins.map(shellQuote).join(":")}:"$PATH" && ${run}`;
}

/** The apps table, then the services table, each when the project has any. */
async function stateTables(
	project: Project,
	lay: Layout,
	here: Machine,
	states: Record<string, DaemonState>,
): Promise<string> {
	const tables: string[] = [];
	if (Object.keys(lay.apps).length > 0) {
		const rows = Object.entries(lay.apps).map(([key, app]) => [
			key,
			app.url,
			states[key] ?? "stopped",
		]);
		tables.push(table([["APP", "URL", "STATE"], ...rows]));
	}
	const services = Object.entries(project.services);
	if (services.length > 0) {
		const rows: string[][] = [];
		for (const [key, service] of services) {
			const address = await kindOf(service).address(service, placeOf(project, lay, here, key));
			rows.push([key, address, states[key] ?? "stopped"]);
		}
		tables.push(table([["SERVICE", "ADDRESS", "STATE"], ...rows]));
	}
	return tables.join("\n\n");
}

async function failures(
	supervisor: Supervisor,
	project: Project,
	failed: string[],
	since: Date,
): Promise<string> {
	const parts: string[] = [];
	for (const key of failed) {
		const lines = await supervisor.logs(project.name, key, since, FAILED_LINES);
		parts.push(
			[
				`\`${key}\` exited on start. Its last output:`,
				...(lines.length > 0 ? lines : ["(none)"]).map((line) => `  ${line}`),
				`For more, run: ${supervisor.logsCommand(project.name, key)}`,
			].join("\n"),
		);
	}
	return parts.join("\n");
}

async function down({ cwd, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const supervisor = await openSupervisor(machine(process.env));
	await supervisor.stop(project.name);
	print(`Stopped ${project.name}'s apps and services.`);
}

async function status({ cwd, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const here = machine(process.env);
	if (Object.keys(project.apps).length === 0 && Object.keys(project.services).length === 0) {
		print(`${project.file} names no apps or services.`);
		return;
	}
	const supervisor = await openSupervisor(here);
	const states = await supervisor.status(project.name);
	// With no supervisor running nothing answers on 443, so the URL form is the port's default.
	const lay = layout(
		project,
		Object.keys(states).length > 0 ? await machineWithPortFree(here, supervisor) : here,
	);
	print(await stateTables(project, lay, here, states));
}
