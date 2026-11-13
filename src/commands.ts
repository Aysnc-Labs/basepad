import { existsSync } from "node:fs";
import { readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { kindOf, type NamesOf, type Place, type Service, type WorktreeData } from "./catalogue.ts";
import { readHookInput } from "./claude-hooks.ts";
import { CONFIG_FILE, findConfig, LABEL, loadProject, type Project } from "./config.ts";
import { copyEnvFiles, writeEnvFiles } from "./env-files.ts";
import { dropHosts, syncHosts } from "./hosts.ts";
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
	servicesHome,
	suffixOf,
} from "./layout.ts";
import { setup, trustAsRoot } from "./setup.ts";
import { type Daemon, type DaemonState, openSupervisor, type Supervisor } from "./supervisor.ts";
import {
	checkOutWorktree,
	checkoutOf,
	clonePaths,
	hasChanges,
	type Listed,
	listWorktrees,
	removeCheckout,
	runSetup,
} from "./worktrees.ts";

export interface Flag {
	short?: string;
	description: string;
	/** What the flag's value is, for one that takes one (`--branch <name>`); a switch has none. */
	value?: string;
}

export interface Invocation {
	cwd: string;
	/** The arguments given, in the order the command's `args` names them. */
	args: string[];
	/** The flags given, by long name: `true` for a switch, the value for a flag that takes one. */
	flags: Record<string, boolean | string>;
	/** Prints one line of the command's output. */
	print(line: string): void;
}

/** One `basepad` command. The CLI dispatches from, and generates help from, `COMMANDS`. */
export interface Command {
	summary: string;
	/** The names of the arguments it takes, in order; one ending in `?` is optional. */
	args?: string[];
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
			claude: {
				description:
					"Claude Code's WorktreeCreate hook: read its input on stdin, use its name as the branch, print only the path",
			},
		},
		run: worktreeAdd,
	},
	"worktree ls": {
		summary: "List main's worktrees with their branches and folders",
		flags: {},
		run: worktreeLs,
	},
	"worktree rm": {
		summary:
			"Remove a worktree: its apps, databases, registrations and git worktree; its branch stays",
		args: ["name?"],
		flags: {
			force: { description: "Remove it even with uncommitted changes, which are lost" },
			claude: {
				description:
					"Claude Code's WorktreeRemove hook: remove the worktree at its input's path, as --force does",
			},
		},
		run: worktreeRm,
	},
	prune: {
		summary: "Remove what is left of worktrees whose folder is gone, after showing it",
		flags: {
			yes: {
				short: "y",
				description:
					"Remove worktrees' leftovers without asking; a removed service's data is still asked",
			},
		},
		run: prune,
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
	if (!LABEL.test(checkout.suffix)) {
		throw new BasepadError(
			`${project.root} is git worktree \`${checkout.suffix}\`, and a worktree's folder name is its suffix in domains and databases, so it must be a lowercase DNS label (letters, digits and inner hyphens). Rename it with \`git worktree move <folder> <new-folder>\`.`,
		);
	}
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
			depends: services.map((service) => (ports.services[service] as ServicePlace).daemon),
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
		const states = await supervisor.start(lay.mainNamespace, services, APP_WAIT_MS, {});
		const failed = services.filter((key) => states[key] === "failed");
		if (failed.length > 0)
			throw new BasepadError(await failures(supervisor, lay.mainNamespace, failed, since));
		for (const key of services) {
			const service = project.services[key] as Service;
			try {
				outputs[key] = await kindOf(service).provision(service, placeOf(project, lay, here, key), {
					claim: context.claim,
					print,
					stopped: async () => {
						const state = (await supervisor.status(lay.mainNamespace))[key];
						return state === "failed" || state === "stopped";
					},
				});
			} catch (error) {
				if (!(error instanceof Stopped)) throw error;
				throw new BasepadError(await failures(supervisor, lay.mainNamespace, [key], since));
			}
		}
	}
	for (const [key, app] of Object.entries(lay.apps)) outputs[key] = { url: app.url };
	const files = envFiles(project, outputs);
	if (main !== undefined) await copyEnvFiles(main.root, project.root, Object.keys(files));
	await writeEnvFiles(project.root, files);
	return lay;
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
		await stateTables(environment, lay, here, await withServices(supervisor, project, lay, states)),
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
	const hook = flags.claude === true;
	if (hook && (flags.branch !== undefined || flags.json === true)) {
		throw new BasepadError(
			"`--claude` takes the branch from Claude Code's hook input and prints only the path, so it goes without `--branch` and `--json`.",
		);
	}
	// With `--json` or `--claude`, stdout carries the answer alone.
	const say = flags.json === true || hook ? (line: string) => console.error(line) : print;
	const input = hook ? await readHookInput("WorktreeCreate") : undefined;
	const at = await environmentAt(input?.cwd ?? cwd);
	const main = at.main ?? at.project;
	const context = await open({ project: main }, {}, say);
	await ready({ project: main }, context);
	// Main's config is read before checking out, so a name too long fails before anything is made.
	const requested = input?.name ?? (typeof flags.branch === "string" ? flags.branch : undefined);
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
		const all = await withServices(context.supervisor, environment.project, lay, states);
		say(await stateTables(environment, lay, context.here, all));
		say("");
		say(
			`Made worktree ${suffix} at ${root}, on branch ${branch}. ${flags.start === true ? "Its apps are started." : "Its apps start when their domains are first opened, or with `basepad up` there."}`,
		);
	}
	if (hook) print(root);
	if (failure !== undefined) throw new BasepadError(failure);
}

/** A worktree's daemon states with its services', which run in main's namespace. */
async function withServices(
	supervisor: Supervisor,
	project: Project,
	lay: Pick<Layout, "suffix" | "mainNamespace">,
	states: Record<string, DaemonState>,
): Promise<Record<string, DaemonState>> {
	if (lay.suffix === undefined) return states;
	const main = await supervisor.status(lay.mainNamespace);
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
	// Held first, so no request starts an app again while it stops.
	await supervisor.hold(namespace, Object.keys(project.apps));
	await supervisor.stop(namespace);
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
	const ports = layout(project, here, suffix);
	const states = await withServices(
		supervisor,
		project,
		ports,
		await supervisor.status(ports.namespace),
	);
	// With no supervisor running nothing answers on 443, so the URL form is the port's default.
	const lay = layout(
		project,
		Object.keys(states).length > 0 ? await machineWithPortFree(here, supervisor) : here,
		suffix,
	);
	print(await stateTables(environment, lay, here, states));
	if (suffix === undefined) await printWorktrees(project, here, supervisor, print);
}

/**
 * Main's project, from main's folder or a worktree's. Reads main's config alone, so a worktree's
 * broken config does not stand in the way.
 */
async function mainAt(cwd: string): Promise<Project> {
	const root = dirname(findConfig(cwd));
	const checkout = await checkoutOf(root);
	return loadProject(checkout.suffix === undefined ? root : checkout.main);
}

/**
 * `status` in main: each worktree git lists, with its tables from its own config, then what is left
 * of worktrees whose folder is gone.
 */
async function printWorktrees(
	main: Project,
	here: Machine,
	supervisor: Supervisor,
	print: Invocation["print"],
): Promise<void> {
	for (const tree of await listWorktrees(main)) {
		print("");
		print(`${tree.suffix} on branch ${tree.branch ?? "(detached)"} at ${tree.root}`);
		if (!tree.present) {
			print("Its folder is gone; `basepad prune` clears what is left of it.");
			continue;
		}
		try {
			const environment = await environmentAt(tree.root);
			const ports = layout(environment.project, here, tree.suffix);
			const states = await withServices(
				supervisor,
				environment.project,
				ports,
				await supervisor.status(ports.namespace),
			);
			const lay = layout(
				environment.project,
				await machineWithPortFree(here, supervisor),
				tree.suffix,
			);
			print(await stateTables(environment, lay, here, states));
		} catch (error) {
			if (!(error instanceof BasepadError)) throw error;
			print(error.message);
		}
	}
	const left = await leftoversOf(main, here, supervisor);
	const rows = leftoverRows({ ...left, checkouts: [] });
	if (rows.length > 1) {
		print("");
		print("Left by worktrees whose folder is gone; `basepad prune` removes it:");
		print(table(rows));
	}
}

async function worktreeLs({ cwd, print }: Invocation): Promise<void> {
	const main = await mainAt(cwd);
	const trees = await listWorktrees(main);
	if (trees.length === 0) {
		print("No worktrees. Make one with `basepad worktree add`.");
		return;
	}
	const rows = trees.map((tree) => [
		tree.suffix,
		tree.branch ?? "(detached)",
		tree.present ? tree.root : `${tree.root} (gone; \`basepad prune\` clears it)`,
	]);
	print(table([["WORKTREE", "BRANCH", "FOLDER"], ...rows]));
}

/**
 * `worktree rm`: removes a worktree from its suffix alone (git's record, the name pattern of its data,
 * its registration), so it works whatever state its folder or config is in. Its branch stays.
 */
async function worktreeRm({ cwd, flags, args, print }: Invocation): Promise<void> {
	if (flags.claude === true) return worktreeRmHook(cwd, args);
	const [suffix] = args;
	if (suffix === undefined) throw new BasepadError("Usage: basepad worktree rm <name> [flags]");
	const main = await mainAt(cwd);
	const tree = (await listWorktrees(main)).find((listed) => listed.suffix === suffix);
	if (tree === undefined) {
		throw new BasepadError(
			`${main.name} has no worktree \`${suffix}\`. \`basepad worktree ls\` lists them; \`basepad prune\` clears what is left of one whose git worktree is gone.`,
		);
	}
	if (tree.present && flags.force !== true && (await hasChanges(tree.path))) {
		throw new BasepadError(
			`${tree.path} has uncommitted changes. Commit or stash them, or pass \`--force\` to lose them.`,
		);
	}
	await removeWorktree(main, tree, print);
}

/**
 * `worktree rm --claude`: removes the worktree at the hook input's `worktree_path`, changes and all:
 * Claude Code has asked before discarding work, or found none. Says everything on stderr.
 */
async function worktreeRmHook(cwd: string, args: string[]): Promise<void> {
	if (args.length > 0) {
		throw new BasepadError(
			"`--claude` takes the worktree from Claude Code's hook input, so it goes without a name.",
		);
	}
	const input = await readHookInput("WorktreeRemove");
	const path = await realpath(input.worktree_path).catch(() => input.worktree_path);
	// From the worktree itself while it exists, so a session folder elsewhere does not matter.
	const checkout = existsSync(path) ? await checkoutOf(path) : {};
	const main =
		checkout.suffix === undefined
			? await mainAt(input.cwd ?? cwd)
			: await loadProject(checkout.main);
	const tree = (await listWorktrees(main)).find((t) => t.root === path || t.path === path);
	if (tree === undefined) {
		throw new BasepadError(
			`${input.worktree_path} is no worktree of ${main.name}'s main at ${main.root}. \`basepad worktree ls\` lists them.`,
		);
	}
	await removeWorktree(main, tree, (line) => console.error(line));
}

/** Removes a listed worktree of main: what basepad made for it, then its git worktree. */
async function removeWorktree(
	main: Project,
	tree: Listed,
	print: Invocation["print"],
): Promise<void> {
	// Main's servers hold the worktree's data, so they run for it to be dropped.
	const context = await open({ project: main }, {}, print);
	await ready({ project: main }, context);
	await removeEnvironment(main, tree.suffix, tree.root, context);
	await removeCheckout(main, tree.path);
	print(
		`Removed worktree ${tree.suffix}: its apps, databases and git worktree.${tree.branch === undefined ? "" : ` Its branch ${tree.branch} is kept.`}`,
	);
}

/**
 * Removes what basepad made for worktree `suffix` of main, from main's config alone: its apps and
 * registration, its domains in the hosts file, and its data on main's servers (never main's own: a
 * `shared` service's is main's).
 */
async function removeEnvironment(
	main: Project,
	suffix: string,
	root: string,
	{ here, supervisor }: Context,
): Promise<void> {
	let lay: Layout;
	try {
		lay = layout(main, here, suffix);
	} catch (error) {
		// A suffix past the limits never had an environment: `up` refused it before making anything.
		if (error instanceof BasepadError) return;
		throw error;
	}
	await supervisor.unregister(lay);
	await dropHosts(lay.namespace);
	for (const [key, service] of Object.entries(main.services)) {
		const place = { ...placeOf(main, lay, here, key), owner: root };
		const data = await kindOf(service).worktreeData(service, place);
		await kindOf(service).dropWorktreeData(
			service,
			place,
			data.map((d) => d.name),
		);
	}
}

/** What is left of worktrees whose folder is gone. */
interface Leftovers {
	/** git's records of them. */
	checkouts: Listed[];
	/** Their data on main's servers, by service key. */
	data: { key: string; data: WorktreeData[] }[];
	/** Their registrations with the supervisor. */
	registrations: { namespace: string; dir: string }[];
}

/** Found by name alone: git's list, data stamped with a gone folder, registrations of a gone folder. */
async function leftoversOf(
	main: Project,
	here: Machine,
	supervisor: Supervisor,
): Promise<Leftovers> {
	const checkouts = (await listWorktrees(main)).filter((tree) => !tree.present);
	const lay = layout(main, here);
	const data: Leftovers["data"] = [];
	for (const [key, service] of Object.entries(main.services)) {
		const found = await kindOf(service).worktreeData(service, placeOf(main, lay, here, key));
		const gone = found.filter((d) => d.owner !== "" && !existsSync(d.owner));
		if (gone.length > 0) data.push({ key, data: gone });
	}
	const registrations = (await supervisor.registrations()).filter(
		(entry) => suffixOf(main.name, entry.namespace) !== undefined && !existsSync(entry.dir),
	);
	return { checkouts, data, registrations };
}

/** Leftovers as a table's rows, its header first. */
function leftoverRows({ checkouts, data, registrations }: Leftovers): string[][] {
	return [
		["LEFTOVER", "NAME", "FOLDER"],
		...checkouts.map((tree) => ["git worktree", tree.suffix, tree.path]),
		...data.flatMap(({ key, data }) => data.map((d) => [`${key} data`, d.name, d.owner])),
		...registrations.map((entry) => ["registration", entry.namespace, entry.dir]),
	];
}

/** The folders in basepad's home of services main's config no longer has, by key. */
async function removedServices(main: Project, here: Machine): Promise<[string, string][]> {
	const home = servicesHome(here, main.name);
	if (!existsSync(home)) return [];
	return (await readdir(home))
		.filter((key) => !(key in main.services))
		.map((key) => [key, join(home, key)]);
}

/**
 * `prune`: lists what is left of worktrees whose folder is gone, and the data of services main's
 * config no longer has, then asks before removing each. `--yes` answers for the first only: a
 * removed service's data is main's too, so it is deleted only on a terminal's yes.
 */
async function prune({ cwd, flags, print }: Invocation): Promise<void> {
	const main = await mainAt(cwd);
	const context = await open({ project: main }, {}, print);
	await ready({ project: main }, context);
	const { here, supervisor } = context;
	const left = await leftoversOf(main, here, supervisor);
	const rows = leftoverRows(left);
	const services = await removedServices(main, here);
	if (rows.length === 1 && services.length === 0) {
		print("Nothing to prune.");
		return;
	}
	if (rows.length > 1) {
		print("Left by worktrees whose folder is gone:");
		print(table(rows));
	}
	if (services.length > 0) {
		print(`Data of services no longer in ${main.file}, main's included:`);
		print(table([["SERVICE", "FOLDER"], ...services]));
	}
	let unasked = false;
	if (rows.length > 1) {
		const yes = flags.yes === true || (await ask("Remove what worktrees left?"));
		if (yes === undefined) unasked = true;
		else if (yes) {
			await removeLeftovers(main, left, context);
			print("Removed what worktrees left.");
		} else print("Kept what worktrees left.");
	}
	if (services.length > 0) {
		const yes = await ask(
			`Delete the data of ${services.map(([key]) => `\`${key}\``).join(", ")}?`,
		);
		if (yes === true) {
			// A service taken out of the config keeps running until stopped.
			await supervisor.stop(
				layout(main, here).mainNamespace,
				services.map(([key]) => key),
			);
			for (const [, folder] of services) await rm(folder, { recursive: true, force: true });
			print(`Deleted ${services.map(([, folder]) => folder).join(", ")}.`);
		} else {
			print(
				`Kept the data of removed services${yes === undefined ? "; `basepad prune` on a terminal asks to delete it" : ""}.`,
			);
		}
	}
	if (unasked) {
		throw new BasepadError(
			"Nothing worktrees left was removed: there is no terminal to ask. Run `basepad prune --yes` to remove it.",
		);
	}
}

async function removeLeftovers(main: Project, left: Leftovers, context: Context): Promise<void> {
	const { here, supervisor } = context;
	const lay = layout(main, here);
	for (const { key, data } of left.data) {
		const service = main.services[key] as Service;
		await kindOf(service).dropWorktreeData(
			service,
			placeOf(main, lay, here, key),
			data.map((d) => d.name),
		);
	}
	for (const { namespace } of left.registrations) {
		const definitions = layout(main, here, suffixOf(main.name, namespace)).definitions;
		await supervisor.unregister({ namespace, definitions });
		await dropHosts(namespace);
	}
	for (const tree of left.checkouts) await removeCheckout(main, tree.path);
}

/** Asks a yes-or-no question on the terminal; with no terminal, no answer. */
async function ask(question: string): Promise<boolean | undefined> {
	if (!process.stdin.isTTY) return undefined;
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await prompt.question(`${question} [y/N] `);
	prompt.close();
	return /^y(es)?$/i.test(answer.trim());
}
