import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { checkOutWorktree, checkoutOf, clonePaths, runSetup } from "./worktrees.ts";

export interface Flag {
	short?: string;
	description: string;
	/** What the flag's value is, for one that takes one (`--branch <name>`); a switch has none. */
	value?: string;
}

export interface Invocation {
	cwd: string;
	/** The flags given, by long name: `true` for a switch, the value for a flag that takes one. */
	flags: Record<string, boolean | string>;
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
	"worktree add": {
		summary: "Make a worktree of main, with its own databases, domains and env files",
		flags: {
			json: { description: "Print only the worktree's name and path, as JSON" },
			branch: {
				value: "name",
				description: "Check out this branch, or make it from main's HEAD when it does not exist",
			},
			start: { description: "Start its apps now, not on the first request to their domains" },
		},
		run: worktreeAdd,
	},
};

/** How long `up` waits for apps to listen or fail before it shows their state and returns. */
const APP_WAIT_MS = 5000;
/** How many of a failed app's last lines `up` shows. */
const FAILED_LINES = 20;

/** One environment: main, or a worktree, which knows its suffix and main's project. */
interface Environment {
	project: Project;
	suffix?: string;
	main?: Project;
}

/** The environment whose config is in `cwd` or its nearest parent with one. */
async function environmentAt(cwd: string): Promise<Environment> {
	const project = await loadProject(cwd);
	const checkout = await checkoutOf(project.root);
	if (checkout.suffix === undefined) return { project };
	if (!existsSync(join(checkout.main, CONFIG_FILE))) {
		throw new BasepadError(
			`${project.root} is git worktree \`${checkout.suffix}\`, made from ${checkout.main}, which has no ${CONFIG_FILE}. A worktree is made from main: commit the config there and run \`basepad up\` in it.`,
		);
	}
	const main = await loadProject(checkout.main);
	if (main.name !== project.name) {
		throw new BasepadError(
			`This worktree's config names the project "${project.name}", and main's (${main.file}) "${main.name}". A worktree's services are main's, so their names must match.`,
		);
	}
	return { project, suffix: checkout.suffix, main };
}

/** What `ready` needs from the command: the machine, the supervisor, and the developer's say. */
interface Context {
	here: Machine;
	supervisor: Supervisor;
	claim: boolean;
	print(line: string): void;
}

/**
 * Makes an environment ready to start its apps: registers its definitions, starts its services
 * (main's, in a worktree) and provisions them, and writes its env files. Starts no app. A worktree
 * needs main ready first.
 */
async function ready(environment: Environment, context: Context): Promise<Layout> {
	const { project, suffix, main } = environment;
	const { here, supervisor, print } = context;
	// Ports, folders and databases; the URL form waits for the supervisor, which answers on 443.
	const ports = layout(project, here, suffix);
	const services = Object.keys(project.services);
	const owner = await supervisor.owner(ports.namespace);
	if (owner !== undefined && owner !== project.root && !context.claim) {
		throw new BasepadError(
			`"${ports.namespace}" is the name of the checkout at ${owner}. Two checkouts under one name would share its databases and domains, so basepad stops here.\nIf that checkout moved here, or this one should take over, run \`basepad up --claim\`.`,
		);
	}
	const missing = services.filter((key) => main !== undefined && !(key in main.services));
	if (missing.length > 0) {
		throw new BasepadError(
			`This worktree's config has ${missing.map((key) => `\`${key}\``).join(", ")}, which main's has not. A worktree's services run on main's servers: add ${missing.length > 1 ? "them" : "it"} to main's config and run \`basepad up\` there first.`,
		);
	}
	const daemons: Record<string, Daemon> = {};
	// Each service has one server for all of a project's environments, run in main's namespace.
	if (suffix === undefined) {
		for (const key of services) {
			const service = project.services[key] as Service;
			daemons[key] = await kindOf(service).prepare(service, placeOf(project, ports, here, key));
		}
	}
	for (const [key, app] of Object.entries(project.apps)) {
		daemons[key] = {
			run: withLocalBins(project, app.cwd, app.run),
			dir: app.cwd,
			port: ports.apps[key]?.port,
			// So the proxy's start on a first request starts the servers first, wherever they run.
			depends: services.map((service) => `${project.name}/${service}`),
		};
	}
	await supervisor.register({
		namespace: ports.namespace,
		...(suffix === undefined ? { label: project.name } : {}),
		dir: project.root,
		definitions: ports.definitions,
		daemons,
	});
	if (suffix === undefined && isRootOnLinux()) {
		for (const line of await trustAsRoot(supervisor)) print(line);
	}
	const lay = layout(project, await machineWithPortFree(here, supervisor), suffix);
	for (const line of await syncHosts(
		lay.namespace,
		Object.values(lay.apps).map((a) => a.host),
	)) {
		print(line);
	}
	const since = new Date(Date.now() - 1000);
	const outputs: Record<string, unknown> = {};
	if (services.length > 0) {
		const states = await supervisor.start(project.name, services, APP_WAIT_MS, {});
		const failed = services.filter((key) => states[key] === "failed");
		if (failed.length > 0)
			throw new BasepadError(await failures(supervisor, project.name, failed, since));
		for (const key of services) {
			const service = project.services[key] as Service;
			try {
				outputs[key] = await kindOf(service).provision(service, placeOf(project, lay, here, key), {
					claim: context.claim,
					stopped: async () => {
						const state = (await supervisor.status(project.name))[key];
						return state === "failed" || state === "stopped";
					},
				});
			} catch (error) {
				if (!(error instanceof Stopped)) throw error;
				throw new BasepadError(await failures(supervisor, project.name, [key], since));
			}
		}
	}
	for (const [key, app] of Object.entries(lay.apps)) outputs[key] = { url: app.url };
	const files = envFiles(project, outputs);
	if (main !== undefined) await copyEnvFiles(main.root, project.root, Object.keys(files));
	await writeEnvFiles(project.root, files);
	return lay;
}

/**
 * Copies each env file a worktree lacks from main's folder, so its other lines (secrets, settings)
 * come along before basepad sets its own keys. A file the worktree has is its own, and kept.
 */
async function copyEnvFiles(from: string, to: string, paths: string[]): Promise<void> {
	for (const path of paths) {
		const source = resolve(from, path);
		const target = resolve(to, path);
		if (existsSync(target) || !existsSync(source)) continue;
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
}

/** Opens the supervisor, and readies main first when the environment is a worktree. */
async function open(environment: Environment, flags: Invocation["flags"], print: Context["print"]) {
	const here = machine(process.env);
	const supervisor = await openSupervisor(here, print);
	const context: Context = { here, supervisor, claim: flags.claim === true, print };
	// `--claim` in a worktree claims the worktree's, never main's.
	if (environment.main !== undefined) {
		await ready({ project: environment.main }, { ...context, claim: false });
	}
	return context;
}

async function up({ cwd, flags, print }: Invocation): Promise<void> {
	const environment = await environmentAt(cwd);
	const { project } = environment;
	const context = await open(environment, flags, print);
	const { supervisor, here } = context;
	const lay = await ready(environment, context);
	const { states, failure } = await startApps(supervisor, project, lay);
	print(
		await stateTables(environment, lay, here, await withServices(supervisor, environment, states)),
	);
	if (failure !== undefined) throw new BasepadError(failure);
}

/**
 * Starts the environment's apps and waits briefly for them. Returns their states, and the report
 * of those that failed, if any did.
 */
async function startApps(
	supervisor: Supervisor,
	project: Project,
	lay: Layout,
): Promise<{ states: Record<string, DaemonState>; failure?: string }> {
	const since = new Date(Date.now() - 1000);
	const apps = Object.keys(project.apps);
	const hosts = Object.fromEntries(Object.entries(lay.apps).map(([key, app]) => [key, app.host]));
	const states = await supervisor.start(lay.namespace, apps, APP_WAIT_MS, hosts);
	const failed = apps.filter((key) => states[key] === "failed");
	if (failed.length === 0) return { states };
	return { states, failure: await failures(supervisor, lay.namespace, failed, since) };
}

/**
 * `worktree add`: checks out a new worktree of main, copies the paths its config clones, readies it
 * (its databases from main's, its env files from main's) and runs its setup commands. Its apps
 * start on the first request to their domains, or now with `--start`. Prints where it is.
 */
async function worktreeAdd({ cwd, flags, print }: Invocation): Promise<void> {
	// With `--json`, stdout carries the answer alone.
	const say = flags.json === true ? (line: string) => console.error(line) : print;
	const at = await environmentAt(cwd);
	const main = at.main ?? at.project;
	const context = await open({ project: main }, {}, say);
	await ready({ project: main }, context);
	// Main's config is read before checking out, so a name too long fails before anything is made.
	const requested = typeof flags.branch === "string" ? flags.branch : undefined;
	const { suffix, branch, root } = await checkOutWorktree(main, requested);
	const kept = `Worktree ${suffix} is checked out at ${root}`;
	let environment: Environment;
	let lay: Layout;
	try {
		environment = await environmentAt(root);
		const { project } = environment;
		for (const note of await clonePaths(main.root, project.root, project.worktrees.clone))
			say(note);
		lay = await ready(environment, context);
	} catch (error) {
		if (!(error instanceof BasepadError)) throw error;
		throw new BasepadError(
			`${error.message}\n${kept}; once that is fixed, run \`basepad up\` there.`,
		);
	}
	try {
		await runSetup(environment.project.root, environment.project.worktrees.setup, say);
	} catch (error) {
		if (!(error instanceof BasepadError)) throw error;
		throw new BasepadError(
			`${error.message}\n${kept}; once that is fixed, run the rest of \`worktrees.setup\` there.`,
		);
	}
	const { states, failure } =
		flags.start === true
			? await startApps(context.supervisor, environment.project, lay)
			: { states: {}, failure: undefined };
	if (flags.json === true) {
		print(JSON.stringify({ name: suffix, path: root }));
	} else {
		const all = await withServices(context.supervisor, environment, states);
		print(await stateTables(environment, lay, context.here, all));
		print("");
		print(
			`Made worktree ${suffix} at ${root}, on branch ${branch}. ${flags.start === true ? "Its apps are started." : "Its apps start when their domains are first opened, or with `basepad up` there."}`,
		);
	}
	if (failure !== undefined) throw new BasepadError(failure);
}

/** A worktree's daemon states with its services', which run in main's namespace. */
async function withServices(
	supervisor: Supervisor,
	{ project, suffix }: Environment,
	states: Record<string, DaemonState>,
): Promise<Record<string, DaemonState>> {
	if (suffix === undefined) return states;
	const main = await supervisor.status(project.name);
	const services = Object.keys(project.services).map((key) => [key, main[key] ?? "stopped"]);
	return { ...states, ...Object.fromEntries(services) };
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
	const suffix = lay.suffix === undefined ? {} : { suffix: lay.suffix };
	return { name: project.name, key, owner: project.root, machine: here, ...suffix, ...service };
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
	{ project }: Environment,
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
	namespace: string,
	failed: string[],
	since: Date,
): Promise<string> {
	const parts: string[] = [];
	for (const key of failed) {
		const lines = await supervisor.logs(namespace, key, since, FAILED_LINES);
		parts.push(
			[
				`\`${key}\` exited on start. Its last output:`,
				...(lines.length > 0 ? lines : ["(none)"]).map((line) => `  ${line}`),
				`For more, run: ${supervisor.logsCommand(namespace, key)}`,
			].join("\n"),
		);
	}
	return parts.join("\n");
}

async function down({ cwd, print }: Invocation): Promise<void> {
	const { project, suffix } = await environmentAt(cwd);
	const supervisor = await openSupervisor(machine(process.env), print);
	const { namespace } = layout(project, machine(process.env), suffix);
	await supervisor.stop(namespace, Object.keys(project.apps));
	// A worktree's services are main's, which keeps them.
	print(
		suffix === undefined
			? `Stopped ${project.name}'s apps and services.`
			: `Stopped worktree ${suffix}'s apps; its services are main's and keep running.`,
	);
}

async function status({ cwd, print }: Invocation): Promise<void> {
	const environment = await environmentAt(cwd);
	const { project, suffix } = environment;
	const here = machine(process.env);
	if (Object.keys(project.apps).length === 0 && Object.keys(project.services).length === 0) {
		print(`${project.file} names no apps or services.`);
		return;
	}
	const supervisor = await openSupervisor(here, print);
	const { namespace } = layout(project, here, suffix);
	const states = await withServices(supervisor, environment, await supervisor.status(namespace));
	// With no supervisor running nothing answers on 443, so the URL form is the port's default.
	const lay = layout(
		project,
		Object.keys(states).length > 0 ? await machineWithPortFree(here, supervisor) : here,
		suffix,
	);
	print(await stateTables(environment, lay, here, states));
}
