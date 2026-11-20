import { existsSync } from "node:fs";
import { readdir, realpath, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import {
	type Database,
	kindOf,
	type NamesOf,
	type Place,
	type Service,
	type WorktreeData,
} from "./catalogue.ts";
import { readHookInput } from "./claude-hooks.ts";
import { CONFIG_FILE, LABEL, loadProject, type Project } from "./config.ts";
import { copyEnvFiles, writeEnvFiles } from "./env-files.ts";
import { runHook } from "./hooks.ts";
import { dropHosts, syncHosts } from "./hosts.ts";
import type { EnvFiles } from "./index.ts";
import { BasepadError, shellQuote } from "./internal/exec.ts";
import { throughMise } from "./internal/mise.ts";
import { Stopped } from "./internal/ports.ts";
import { table } from "./internal/table.ts";
import {
	daemonId,
	daemonsOf,
	definitionsFile,
	extraDaemonNames,
	isRootOnLinux,
	type Layout,
	layout,
	localhostCertificate,
	type Machine,
	machine,
	namespaceOf,
	ofDaemon,
	ownServers,
	placeOf,
	type ServicePlace,
	servicesHome,
	suffixOf,
	supervisorPaths,
} from "./layout.ts";
import { told } from "./mission-control/feed.ts";
import { hooksId } from "./mission-control/model.ts";
import { setup, trustAsRoot } from "./setup.ts";
import {
	type Daemon,
	type DaemonState,
	openSupervisor,
	type Supervisor,
	startFailure,
} from "./supervisor.ts";
import { ensureLocalhostCertificate } from "./tls.ts";
import {
	checkedOut,
	checkOutWorktree,
	checkoutOf,
	clonePaths,
	hasChanges,
	type Listed,
	listWorktrees,
	removeCheckout,
} from "./worktrees.ts";

export interface Flag {
	short?: string;
	description: string;
	value?: string;
}

export interface Invocation {
	cwd: string;
	args: string[];
	flags: Record<string, boolean | string>;
	print(line: string): void;
}

export interface Command {
	summary: string;
	args?: string[];
	flags: Record<string, Flag>;
	run(invocation: Invocation): Promise<void>;
}

const SERVICE_FLAG: Flag = {
	short: "s",
	value: "key",
	description: "The database service to act on; needed when there are several",
};

export const COMMANDS: Record<string, Command> = {
	setup: {
		summary: "Once per machine: trust basepad's certificate and drop the port from URLs",
		flags: {
			"dry-run": { description: "Print the plan and change nothing" },
			yes: { short: "y", description: "Apply the plan without asking" },
		},
		run: setup,
	},
	up: {
		summary: "Start this project's services and apps, set its env files, then open mission control",
		flags: {
			detach: {
				short: "d",
				description: "Return once started, without opening mission control (as with no terminal)",
			},
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
		args: ["worktree?"],
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
	"db save": {
		summary: "Save this environment's database as a snapshot, replacing one of the same label",
		args: ["label?"],
		flags: { service: SERVICE_FLAG },
		run: dbSave,
	},
	"db load": {
		summary: "Replace this environment's database with a snapshot, which is kept",
		args: ["label?"],
		flags: { service: SERVICE_FLAG },
		run: dbLoad,
	},
	"db snapshots": {
		summary: "List this environment's snapshots",
		flags: {},
		run: dbSnapshots,
	},
	"db rm": {
		summary: "Delete one of this environment's snapshots",
		args: ["label"],
		flags: { service: SERVICE_FLAG },
		run: dbRm,
	},
	"db import": {
		summary:
			"Replace this environment's database with a dump file or a postgres:// URL's, after asking",
		args: ["file or url"],
		flags: {
			service: SERVICE_FLAG,
			yes: { short: "y", description: "Replace the database without asking" },
		},
		run: dbImport,
	},
	"db export": {
		summary: "Write a dump of this environment's database to a file, or to standard output",
		args: ["file?"],
		flags: { service: SERVICE_FLAG },
		run: dbExport,
	},
};

const APP_WAIT_MS = 5000;
const FAILED_LINES = 20;

interface Environment {
	project: Project;
	suffix?: string;
	main?: Project;
}

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

interface Context {
	here: Machine;
	supervisor: Supervisor;
	claim: boolean;
	print(line: string): void;
}

async function ready(
	environment: Environment,
	context: Context,
	{ start = () => true }: { start?: (key: string) => boolean } = {},
): Promise<Layout> {
	const { project, suffix, main } = environment;
	const { here, supervisor, print } = context;
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
	for (const key of ownServers(ports)) {
		const service = project.services[key] as Service;
		const prepared = await kindOf(service).prepare(
			service,
			placeOf(project, ports, here, key, main?.root),
		);
		for (const id of daemonsOf(ports.services[key] as ServicePlace)) {
			const daemon = prepared[id];
			if (daemon === undefined) throw new Error(`\`${key}\`'s kind prepared no daemon ${id}.`);
			daemons[ofDaemon(id).name] = daemon;
		}
	}
	const servers = Object.values(ports.services).flatMap(daemonsOf);
	const unreached = Object.keys(project.apps).filter((key) => ports.apps[key]?.host === undefined);
	const tls = localhostCertificate(here);
	for (const [key, app] of Object.entries(project.apps)) {
		const run = withLocalBins(project, app.cwd, app.run);
		const port = ports.apps[key]?.port;
		daemons[key] = {
			run: throughMise(
				app.domain === false
					? `export BASEPAD_TLS_CERT=${shellQuote(tls.cert)} BASEPAD_TLS_KEY=${shellQuote(tls.key)} && ${run}`
					: run,
			),
			dir: app.cwd,
			port,
			...(app.domain === false ? { proxy: false as const } : {}),
			depends: unreached.includes(key)
				? servers
				: [...servers, ...unreached.map((name) => daemonId(ports.namespace, name))],
		};
	}
	if (Object.values(project.apps).some((app) => app.domain === false)) {
		await supervisor.serve();
		const { ca, caKey } = supervisorPaths(here);
		await ensureLocalhostCertificate({ ca, caKey, ...tls });
	}
	await supervisor.register({
		namespace: ports.namespace,
		...(suffix === undefined ? { label: project.name } : {}),
		dir: project.root,
		definitions: ports.definitions,
		daemons,
	});
	await stopOrphans(supervisor, project, here, ports.namespace, Object.keys(daemons));
	const restarts = Object.keys(daemons).filter((name) => daemons[name]?.restart === true);
	if (restarts.length > 0) await supervisor.stop(ports.namespace, restarts);
	if (suffix === undefined && isRootOnLinux()) {
		for (const line of await trustAsRoot(supervisor)) print(line);
	}
	const lay = layout(project, await machineWithPortFree(here, supervisor), suffix);
	const domains = Object.values(lay.services).flatMap((place) =>
		place.web === undefined || suffix !== undefined ? [] : [place.web.host],
	);
	for (const line of await syncHosts(lay.namespace, [
		...Object.values(lay.apps).flatMap((a) => a.host ?? []),
		...domains,
	])) {
		print(line);
	}
	const since = new Date(Date.now() - 1000);
	const outputs: Record<string, unknown> = {};
	const own = ownServers(lay);
	const runsIn = (key: string) => (own.includes(key) ? lay.namespace : lay.mainNamespace);
	const ownDaemons = (namespace: string) => (namespace === ports.namespace ? daemons : {});
	const placeAt = (key: string) => lay.services[key] as ServicePlace;
	const serverOf = (key: string) => ofDaemon(placeAt(key).daemon).name;
	const started = services.filter((key) => runsIn(key) === lay.mainNamespace || start(key));
	for (const namespace of new Set(started.map(runsIn))) {
		const keys = started.filter((key) => runsIn(key) === namespace);
		const names = keys.flatMap((key) => daemonsOf(placeAt(key)).map((id) => ofDaemon(id).name));
		const hosts = Object.fromEntries(
			keys.flatMap((key) => {
				const web = placeAt(key).web;
				return web === undefined ? [] : [[serverOf(key), web.host]];
			}),
		);
		const states = await supervisor.start(namespace, names, APP_WAIT_MS, hosts);
		const failed = names.filter((name) => states[name] === "failed");
		if (failed.length > 0)
			throw new BasepadError(
				await failures(supervisor, namespace, failed, since, ownDaemons(namespace)),
			);
	}
	for (const key of services) {
		const service = project.services[key] as Service;
		const namespace = runsIn(key);
		try {
			outputs[key] = await kindOf(service).provision(
				service,
				placeOf(project, lay, here, key, main?.root),
				{
					claim: context.claim,
					started: started.includes(key),
					print,
					stopped: async () => {
						const state = (await supervisor.status(namespace))[serverOf(key)];
						return state === "failed" || state === "stopped";
					},
				},
			);
		} catch (error) {
			if (!(error instanceof Stopped)) throw error;
			throw new BasepadError(
				await failures(supervisor, namespace, [serverOf(key)], since, ownDaemons(namespace)),
			);
		}
	}
	for (const [key, app] of Object.entries(lay.apps)) {
		if (app.url !== undefined) outputs[key] = { url: app.url };
	}
	const files = envFiles(project, outputs);
	if (main !== undefined) await copyEnvFiles(main.root, project.root, Object.keys(files));
	await writeEnvFiles(project.root, files);
	return lay;
}

async function stopOrphans(
	supervisor: Supervisor,
	project: Project,
	here: Machine,
	namespace: string,
	defined: string[],
): Promise<void> {
	const extras = extraDaemonNames([
		...Object.keys(project.services),
		...(await removedServices(project, here)).map(([key]) => key),
	]);
	const orphans = Object.keys(await supervisor.status(namespace)).filter(
		(name) => !defined.includes(name) && extras.includes(name),
	);
	if (orphans.length > 0) await supervisor.stop(namespace, orphans);
}

async function open(
	environment: Environment,
	flags: Invocation["flags"],
	print: Context["print"],
	opened?: Supervisor,
) {
	const here = machine(process.env);
	const supervisor = opened ?? (await openSupervisor(here, print));
	const context: Context = { here, supervisor, claim: flags.claim === true, print };
	if (environment.main !== undefined) {
		await ready({ project: environment.main }, { ...context, claim: false });
	}
	return context;
}

async function up({ cwd, flags, print }: Invocation): Promise<void> {
	const environment = await environmentAt(cwd);
	if (flags.detach !== true && process.stdin.isTTY && process.stdout.isTTY) {
		return upOnTerminal(environment, flags, print);
	}
	const { project } = environment;
	const context = await open(environment, flags, print);
	const { supervisor, here } = context;
	const lay = await readyOrMade(environment, context, print);
	const hook = upHooks(environment, print);
	await hook("beforeUp");
	const { states, failure } = await startApps(supervisor, project, lay);
	const afterUp = failure === undefined ? await failureOf(hook("afterUp")) : undefined;
	print(await stateTables(environment, lay, here, await withServices(supervisor, lay, states)));
	if (failure !== undefined) throw new BasepadError(failure);
	if (afterUp !== undefined) throw afterUp;
}

function upHooks(environment: Environment, say: (line: string) => void) {
	return (name: "beforeUp" | "afterUp") =>
		runHook(environment.project, name, { environment: environment.suffix, say });
}

const failureOf = (running: Promise<void>): Promise<unknown> =>
	running.then(
		() => undefined,
		(error: unknown) => error,
	);

async function upOnTerminal(
	environment: Environment,
	flags: Invocation["flags"],
	print: Invocation["print"],
): Promise<void> {
	const { project } = environment;
	const here = machine(process.env);
	const { missionControl } = await import("./mission-control/run.ts");
	const held: string[] = [];
	const say = (line: string) => held.push(line);
	const supervisor = await openSupervisor(here, say);
	const selected = layout(project, here, environment.suffix).namespace;
	const hookLog = told(hooksId(selected));
	const hook = upHooks(environment, (line) => {
		say(line);
		hookLog.say(line);
	});
	let served = here;
	let outcome: { lay: Layout; states: Record<string, DaemonState>; failure?: string } | undefined;
	let afterUp: unknown;
	let error: unknown;
	let notice: string | undefined;
	const readying = (async () => {
		const context = await open(environment, flags, say, supervisor);
		const lay = await readyOrMade(environment, { ...context, print: say }, (line) => {
			say(line);
			hookLog.say(line);
		});
		served = await machineWithPortFree(here, supervisor);
		await hook("beforeUp");
		outcome = { lay, ...(await startApps(supervisor, project, lay)) };
		if (outcome.failure !== undefined) {
			const failed = Object.keys(project.apps).filter((key) => outcome?.states[key] === "failed");
			notice = `${failed.map((key) => `\`${key}\``).join(", ")} exited on start; ${failed.length > 1 ? "their" : "its"} output is in the logs.`;
			return;
		}
		afterUp = await failureOf(hook("afterUp"));
		if (afterUp !== undefined) notice = firstLine(messageOf(afterUp));
	})().catch((caught: unknown) => {
		error = caught;
		notice = firstLine(messageOf(caught));
	});
	await missionControl({
		main: environment.main ?? project,
		machine: () => served,
		supervisor,
		failure: () => {
			const shown = notice;
			notice = undefined;
			return shown;
		},
		told: hookLog,
		selected,
		basepad: [process.execPath, ...process.execArgv, process.argv[1] as string],
	});
	if (outcome === undefined && error === undefined) print("Still starting; finishing…");
	await readying;
	for (const line of held) print(line);
	if (error !== undefined) throw error;
	if (outcome === undefined) return;
	const { lay, states, failure } = outcome;
	print(await stateTables(environment, lay, here, await withServices(supervisor, lay, states)));
	if (failure !== undefined) throw new BasepadError(failure);
	if (afterUp !== undefined) throw afterUp;
}

async function readyOrMade(
	environment: Environment,
	context: Context,
	say: (line: string) => void,
): Promise<Layout> {
	const { project, suffix } = environment;
	if (suffix === undefined) return ready(environment, context);
	const registered = await context.supervisor.owner(namespaceOf(project.name, suffix));
	if (registered !== undefined) return ready(environment, context);
	return made(environment, suffix, context, say);
}

async function made(
	environment: Environment,
	suffix: string,
	context: Context,
	say: (line: string) => void,
	{
		start,
		before = async () => {},
	}: { start?: (key: string) => boolean; before?: () => Promise<void> } = {},
): Promise<Layout> {
	const { root } = environment.project;
	const hook = (name: "beforeCreate" | "afterCreate") =>
		runHook(environment.project, name, { environment: suffix, say });
	const lay = await keptOnFailure(suffix, root, UP_THERE, async () => {
		await before();
		await hook("beforeCreate");
		return ready(environment, context, start === undefined ? {} : { start });
	});
	await keptOnFailure(suffix, root, "run the rest of `afterCreate` there", () =>
		hook("afterCreate"),
	);
	return lay;
}

const UP_THERE = "run `basepad up` there";

async function keptOnFailure<T>(
	suffix: string,
	root: string,
	then: string,
	step: () => Promise<T>,
): Promise<T> {
	try {
		return await step();
	} catch (error) {
		if (!(error instanceof BasepadError)) throw error;
		throw new BasepadError(
			`${error.message}\n${checkedOut(suffix, root)}; once that is fixed, ${then}.`,
		);
	}
}

const firstLine = (text: string) => text.split("\n")[0] ?? text;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function startApps(
	supervisor: Supervisor,
	project: Project,
	lay: Layout,
): Promise<{ states: Record<string, DaemonState>; failure?: string }> {
	const since = new Date(Date.now() - 1000);
	const apps = Object.keys(project.apps);
	const hosts = Object.fromEntries(
		Object.entries(lay.apps).flatMap(([key, app]) =>
			app.host === undefined ? [] : [[key, app.host]],
		),
	);
	const states = await supervisor.start(lay.namespace, apps, APP_WAIT_MS, hosts);
	const failed = apps.filter((key) => states[key] === "failed");
	if (failed.length === 0) return { states };
	return { states, failure: await failures(supervisor, lay.namespace, failed, since) };
}

async function worktreeAdd({ cwd, flags, print }: Invocation): Promise<void> {
	const hook = flags.claude === true;
	if (hook && (flags.branch !== undefined || flags.json === true)) {
		throw new BasepadError(
			"`--claude` takes the branch from Claude Code's hook input and prints only the path, so it goes without `--branch` and `--json`.",
		);
	}
	const say = flags.json === true || hook ? (line: string) => console.error(line) : print;
	const input = hook ? await readHookInput("WorktreeCreate") : undefined;
	const at = await environmentAt(input?.cwd ?? cwd);
	const main = at.main ?? at.project;
	const context = await open({ project: main }, {}, say);
	await ready({ project: main }, context);
	const requested = input?.name ?? (typeof flags.branch === "string" ? flags.branch : undefined);
	const { suffix, branch, root } = await checkOutWorktree(main, requested);
	say(`${checkedOut(suffix, root)}.`);
	const environment = await keptOnFailure(suffix, root, UP_THERE, () => environmentAt(root));
	const lay = await made(environment, suffix, context, say, {
		start: () => flags.start === true,
		before: async () => {
			const { project } = environment;
			for (const note of await clonePaths(main.root, project.root, project.worktrees.clone))
				say(note);
		},
	});
	const { states, failure } =
		flags.start === true
			? await startApps(context.supervisor, environment.project, lay)
			: { states: {}, failure: undefined };
	if (flags.json === true) {
		print(JSON.stringify({ name: suffix, path: root }));
	} else {
		const all = await withServices(context.supervisor, lay, states);
		say(await stateTables(environment, lay, context.here, all));
		say("");
		say(
			`Made worktree ${suffix} at ${root}, on branch ${branch}. ${flags.start === true ? "Its apps are started." : "Its apps start when their domains are first opened, or with `basepad up` there."}`,
		);
	}
	if (hook) print(root);
	if (failure !== undefined) throw new BasepadError(failure);
}

async function withServices(
	supervisor: Supervisor,
	lay: Pick<Layout, "namespace" | "mainNamespace" | "services">,
	states: Record<string, DaemonState>,
): Promise<Record<string, DaemonState>> {
	const own = ownServers(lay);
	const mains = Object.entries(lay.services)
		.filter(([key]) => !own.includes(key))
		.flatMap(([, place]) => daemonsOf(place).map((id) => ofDaemon(id).name));
	if (mains.length === 0) return states;
	const main = await supervisor.status(lay.mainNamespace);
	return { ...states, ...Object.fromEntries(mains.map((name) => [name, main[name] ?? "stopped"])) };
}

async function machineWithPortFree(here: Machine, supervisor: Supervisor): Promise<Machine> {
	return { ...here, portFree: (await supervisor.standardPort()) === "proxy" };
}

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

function withLocalBins(project: Project, dir: string, run: string): string {
	const bins = [
		...new Set([join(dir, "node_modules/.bin"), join(project.root, "node_modules/.bin")]),
	];
	return `export PATH=${bins.map(shellQuote).join(":")}:"$PATH" && ${run}`;
}

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
			app.url ?? "",
			states[key] ?? "stopped",
		]);
		tables.push(table([["APP", "URL", "STATE"], ...rows]));
	}
	const services = Object.entries(project.services);
	if (services.length > 0) {
		const rows: string[][] = [];
		for (const [key, service] of services) {
			const place = placeOf(project, lay, here, key);
			const address = await kindOf(service).address(service, place);
			rows.push([key, address, states[ofDaemon(place.daemon).name] ?? "stopped"]);
			for (const [extra, { daemon }] of Object.entries(place.extraDaemons)) {
				const name = ofDaemon(daemon).name;
				const extraAddress = (await kindOf(service).extraAddress?.(place, extra)) ?? "";
				rows.push([name, extraAddress, states[name] ?? "stopped"]);
			}
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
	daemons: Record<string, Daemon> = {},
): Promise<string> {
	const parts: string[] = [];
	for (const key of failed) {
		const lines = await supervisor.logs(namespace, key, since, FAILED_LINES);
		const logs = supervisor.logsCommand(namespace, key);
		parts.push(startFailure(key, lines, logs, daemons[key]?.program));
	}
	return parts.join("\n");
}

async function down({ cwd, print }: Invocation): Promise<void> {
	const { project, suffix } = await environmentAt(cwd);
	const supervisor = await openSupervisor(machine(process.env), print);
	const lay = layout(project, machine(process.env), suffix);
	const { namespace } = lay;
	const apps = Object.keys(project.apps);
	const own = ownServers(lay);
	const mains = Object.keys(project.services).filter((key) => !own.includes(key));
	const hook = (name: "beforeDown" | "afterDown") =>
		runHook(project, name, {
			environment: suffix,
			say: print,
			warn: (line) => console.error(`basepad: ${line}`),
		});
	await hook("beforeDown");
	const landed = process.stdout.isTTY
		? await startLanding(project.name, suffix, [...apps, ...own], mains)
		: undefined;
	try {
		await supervisor.hold(namespace, apps);
		await supervisor.stop(namespace);
	} catch (error) {
		landed?.fail();
		throw error;
	}
	if (landed !== undefined) {
		await landed.land();
		await hook("afterDown");
		return;
	}
	const names = (keys: string[]) => keys.map((key) => `\`${key}\``).join(", ");
	print(
		suffix === undefined
			? `Stopped ${project.name}'s apps and services.`
			: `Stopped worktree ${suffix}'s apps${own.length > 0 ? ` and ${names(own)}` : ""}.${mains.length > 0 ? ` ${names(mains)} ${mains.length > 1 ? "run" : "runs"} on main's and keep${mains.length > 1 ? "" : "s"} running.` : ""}`,
	);
	await hook("afterDown");
}

async function startLanding(
	project: string,
	suffix: string | undefined,
	parts: string[],
	kept: string[],
) {
	const [{ landing }, { colorsFor }, { default: chalk }] = await Promise.all([
		import("./mission-control/launch.ts"),
		import("./mission-control/frame.ts"),
		import("chalk"),
	]);
	return landing({
		project,
		environment: suffix ?? "main",
		parts,
		kept,
		color: colorsFor(process.env.NO_COLOR, chalk.level),
	});
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
	const states = await withServices(supervisor, ports, await supervisor.status(ports.namespace));
	const lay = layout(
		project,
		Object.keys(states).length > 0 ? await machineWithPortFree(here, supervisor) : here,
		suffix,
	);
	print(await stateTables(environment, lay, here, states));
	if (suffix === undefined) await printWorktrees(project, here, supervisor, print);
}

async function mainAt(cwd: string): Promise<Project> {
	const here = await realpath(cwd);
	const checkout = await checkoutOf(here);
	return loadProject(checkout.suffix === undefined ? here : checkout.main);
}

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

async function worktreeRm({ cwd, flags, args, print }: Invocation): Promise<void> {
	if (flags.claude === true) return worktreeRmHook(cwd, args);
	const [suffix] = args;
	if (suffix === undefined) throw new BasepadError("Usage: basepad worktree rm <worktree> [flags]");
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

async function worktreeRmHook(cwd: string, args: string[]): Promise<void> {
	if (args.length > 0) {
		throw new BasepadError(
			"`--claude` takes the worktree from Claude Code's hook input, so it goes without a name.",
		);
	}
	const input = await readHookInput("WorktreeRemove");
	const path = await realpath(input.worktree_path).catch(() => input.worktree_path);
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

async function removeWorktree(
	main: Project,
	tree: Listed,
	print: Invocation["print"],
): Promise<void> {
	const context = await open({ project: main }, {}, print);
	await ready({ project: main }, context);
	const hook = removeHook(main, tree, print);
	await hook("beforeRemove");
	await removeEnvironment(main, tree.suffix, tree.root, context);
	await removeCheckout(main, tree.path);
	await hook("afterRemove");
	print(
		`Removed worktree ${tree.suffix}: its apps, databases and git worktree.${tree.branch === undefined ? "" : ` Its branch ${tree.branch} is kept.`}`,
	);
}

function removeHook(
	main: Project,
	tree: Pick<Listed, "suffix" | "root">,
	say: (line: string) => void,
) {
	return (name: "beforeRemove" | "afterRemove") =>
		runHook(main, name, {
			environment: tree.suffix,
			say,
			keysFrom: tree.root,
			variables: { BASEPAD_WORKTREE: tree.root },
			warn: (line) => console.error(`basepad: ${line}`),
		});
}

async function removeEnvironment(
	main: Project,
	suffix: string,
	root: string,
	{ here, supervisor }: Context,
): Promise<void> {
	const namespace = namespaceOf(main.name, suffix);
	await supervisor.unregister({ namespace, definitions: definitionsFile(here, namespace) });
	await dropHosts(namespace);
	const lay = layout(main, here);
	const tree = worktreeLayout(main, here, suffix);
	for (const [key, service] of Object.entries(main.services)) {
		const store = kindOf(service).worktreeData;
		if (store === undefined) continue;
		const place = placeOf(main, lay, here, key);
		const data =
			tree === undefined
				? (await store.list(service, place)).filter((d) => d.owner === root)
				: await store.list(service, { ...placeOf(main, tree, here, key), owner: root });
		await store.drop(
			service,
			place,
			data.map((d) => d.name),
		);
	}
}

function worktreeLayout(main: Project, here: Machine, suffix: string): Layout | undefined {
	try {
		return layout(main, here, suffix);
	} catch (error) {
		if (error instanceof BasepadError) return undefined;
		throw error;
	}
}

interface Leftovers {
	checkouts: Listed[];
	data: { key: string; data: WorktreeData[] }[];
	registrations: { namespace: string; dir: string }[];
}

async function leftoversOf(
	main: Project,
	here: Machine,
	supervisor: Supervisor,
): Promise<Leftovers> {
	const checkouts = (await listWorktrees(main)).filter((tree) => !tree.present);
	const lay = layout(main, here);
	const data: Leftovers["data"] = [];
	for (const [key, service] of Object.entries(main.services)) {
		const store = kindOf(service).worktreeData;
		if (store === undefined) continue;
		const found = await store.list(service, placeOf(main, lay, here, key));
		const gone = found.filter((d) => d.owner !== "" && !existsSync(d.owner));
		if (gone.length > 0) data.push({ key, data: gone });
	}
	const registrations = (await supervisor.registrations()).filter(
		(entry) => suffixOf(main.name, entry.namespace) !== undefined && !existsSync(entry.dir),
	);
	return { checkouts, data, registrations };
}

function leftoverRows({ checkouts, data, registrations }: Leftovers): string[][] {
	return [
		["LEFTOVER", "NAME", "FOLDER"],
		...checkouts.map((tree) => ["git worktree", tree.suffix, tree.path]),
		...data.flatMap(({ key, data }) => data.map((d) => [`${key} data`, d.name, d.owner])),
		...registrations.map((entry) => ["registration", entry.namespace, entry.dir]),
	];
}

async function removedServices(main: Project, here: Machine): Promise<[string, string][]> {
	const home = servicesHome(here, main.name);
	if (!existsSync(home)) return [];
	return (await readdir(home))
		.filter((key) => !(key in main.services))
		.map((key) => [key, join(home, key)]);
}

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
			const hooks = leftoverWorktrees(main, left).map((tree) => removeHook(main, tree, print));
			for (const hook of hooks) await hook("beforeRemove");
			await removeLeftovers(main, left, context);
			for (const hook of hooks) await hook("afterRemove");
			print("Removed what worktrees left.");
		} else print("Kept what worktrees left.");
	}
	if (services.length > 0) {
		const yes = await ask(
			`Delete the data of ${services.map(([key]) => `\`${key}\``).join(", ")}?`,
		);
		if (yes === true) {
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

function leftoverWorktrees(main: Project, left: Leftovers): Pick<Listed, "suffix" | "root">[] {
	const trees = new Map<string, string>();
	for (const tree of left.checkouts) trees.set(tree.root, tree.suffix);
	for (const { namespace, dir } of left.registrations) {
		const suffix = suffixOf(main.name, namespace);
		if (suffix !== undefined && !trees.has(dir)) trees.set(dir, suffix);
	}
	for (const { data } of left.data) {
		for (const { owner } of data) if (!trees.has(owner)) trees.set(owner, basename(owner));
	}
	return [...trees].map(([root, suffix]) => ({ root, suffix }));
}

async function removeLeftovers(main: Project, left: Leftovers, context: Context): Promise<void> {
	const { here, supervisor } = context;
	const lay = layout(main, here);
	for (const { key, data } of left.data) {
		const service = main.services[key] as Service;
		await kindOf(service).worktreeData?.drop(
			service,
			placeOf(main, lay, here, key),
			data.map((d) => d.name),
		);
	}
	for (const { namespace } of left.registrations) {
		await supervisor.unregister({ namespace, definitions: definitionsFile(here, namespace) });
		await dropHosts(namespace);
	}
	for (const tree of left.checkouts) await removeCheckout(main, tree.path);
}

async function ask(question: string): Promise<boolean | undefined> {
	if (!process.stdin.isTTY) return undefined;
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await prompt.question(`${question} [y/N] `);
	prompt.close();
	return /^y(es)?$/i.test(answer.trim());
}

const DEFAULT_LABEL = "default";

interface DatabaseService {
	key: string;
	service: Service;
	database: Database<Service, NamesOf<Service>>;
}

type DatabaseTarget = DatabaseService & { place: Place<NamesOf<Service>> };

async function databaseServicesAt(
	cwd: string,
): Promise<{ environment: Environment; services: [DatabaseService, ...DatabaseService[]] }> {
	const environment = await environmentAt(cwd);
	const { project } = environment;
	const [first, ...rest] = Object.entries(project.services).flatMap(([key, service]) => {
		const { database } = kindOf(service);
		return database === undefined ? [] : [{ key, service, database }];
	});
	if (first === undefined) {
		throw new BasepadError(`${project.file} names no database service.`);
	}
	return { environment, services: [first, ...rest] };
}

function chosen(
	project: Project,
	services: [DatabaseService, ...DatabaseService[]],
	wanted: unknown,
): DatabaseService {
	const names = services.map(({ key }) => `\`${key}\``).join(", ");
	if (typeof wanted === "string") {
		const found = services.find(({ key }) => key === wanted);
		if (found === undefined) {
			throw new BasepadError(
				`${project.file} has no database service \`${wanted}\`. Its databases: ${names}.`,
			);
		}
		return found;
	}
	const [only, ...more] = services;
	if (more.length > 0) {
		throw new BasepadError(
			`${project.file} has several databases: ${names}. Name one with \`--service <key>\`.`,
		);
	}
	return only;
}

async function readyFor(
	environment: Environment,
	print: Invocation["print"],
	services: DatabaseService[],
): Promise<(service: DatabaseService) => DatabaseTarget> {
	const keys = services.map(({ key }) => key);
	const context = await open(environment, {}, print);
	const lay = await ready(environment, context, { start: (key) => keys.includes(key) });
	return (service) => ({
		...service,
		place: placeOf(environment.project, lay, context.here, service.key, environment.main?.root),
	});
}

async function databaseAt({
	cwd,
	flags,
	print,
}: Invocation): Promise<DatabaseTarget & { environment: Environment }> {
	const { environment, services } = await databaseServicesAt(cwd);
	const service = chosen(environment.project, services, flags.service);
	const onServer = await readyFor(environment, print, [service]);
	return { ...onServer(service), environment };
}

function dbHooks(
	{ environment, key }: { environment: Environment; key: string },
	event: "Save" | "Load" | "Delete" | "Import" | "Export",
	say: (line: string) => void,
	variables: Record<string, string>,
) {
	return (when: "before" | "after") =>
		runHook(environment.project, `${when}${event}`, {
			environment: environment.suffix,
			say,
			variables: { BASEPAD_SERVICE: key, ...variables },
		});
}

function labelOf(args: string[]): string {
	const [label = DEFAULT_LABEL] = args;
	if (!LABEL.test(label)) {
		throw new BasepadError(
			`A snapshot label must be lowercase letters, digits and inner hyphens; got \`${label}\`.`,
		);
	}
	return label;
}

async function dbSave(invocation: Invocation): Promise<void> {
	const label = labelOf(invocation.args);
	const target = await databaseAt(invocation);
	const { key, service, place, database } = target;
	const hook = dbHooks(target, "Save", invocation.print, { BASEPAD_LABEL: label });
	await database.save(service, place, label, () => hook("before"));
	invocation.print(`Saved \`${key}\` as snapshot ${label}.`);
	await hook("after");
}

async function dbLoad(invocation: Invocation): Promise<void> {
	const label = labelOf(invocation.args);
	const target = await databaseAt(invocation);
	const { key, service, place, database } = target;
	const hook = dbHooks(target, "Load", invocation.print, { BASEPAD_LABEL: label });
	await database.load(service, place, label, () => hook("before"));
	invocation.print(`Loaded snapshot ${label} into \`${key}\`.`);
	await hook("after");
}

async function dbRm(invocation: Invocation): Promise<void> {
	const label = labelOf(invocation.args);
	const target = await databaseAt(invocation);
	const { key, service, place, database } = target;
	const hook = dbHooks(target, "Delete", invocation.print, { BASEPAD_LABEL: label });
	await database.remove(service, place, label, () => hook("before"));
	invocation.print(`Deleted snapshot ${label} of \`${key}\`.`);
	await hook("after");
}

async function dbSnapshots({ cwd, print }: Invocation): Promise<void> {
	const { environment, services } = await databaseServicesAt(cwd);
	const onServer = await readyFor(environment, print, services);
	const targets = services.map(onServer);
	const rows: string[][] = [];
	for (const { key, service, place, database } of targets) {
		for (const snapshot of await database.snapshots(service, place)) {
			rows.push([
				snapshot.label,
				key,
				snapshot.database,
				snapshot.invalid ? "invalid" : size(snapshot.bytes),
			]);
		}
	}
	if (rows.length === 0) {
		print("No snapshots. Make one with `basepad db save [label]`.");
		return;
	}
	print(table([["LABEL", "SERVICE", "DATABASE", "SIZE"], ...rows]));
}

function size(bytes: number): string {
	const units = ["B", "kB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

async function dbImport(invocation: Invocation): Promise<void> {
	const [given = ""] = invocation.args;
	const target = await databaseAt(invocation);
	const { key, service, place, database } = target;
	const file = resolve(invocation.cwd, given);
	const source = existsSync(file) ? file : given;
	const hook = dbHooks(target, "Import", invocation.print, { BASEPAD_SOURCE: source });
	let replaced = "";
	const read = await database.import(service, place, source, async (name) => {
		replaced = name;
		if (invocation.flags.yes !== true) await confirmImport(key, name);
		await hook("before");
	});
	invocation.print(`Imported ${read} into \`${key}\`'s database ${replaced}.`);
	await hook("after");
}

async function confirmImport(key: string, name: string): Promise<void> {
	const yes = await ask(`Replace \`${key}\`'s database ${name}? Its data is lost.`);
	if (yes === undefined) {
		throw new BasepadError(
			`Import replaces \`${key}\`'s database ${name}, and there is no terminal to ask. Run it again with \`--yes\` to replace it.`,
		);
	}
	if (!yes) throw new BasepadError(`Nothing imported; ${name} is unchanged.`);
}

async function dbExport(invocation: Invocation): Promise<void> {
	const [given] = invocation.args;
	if (given === undefined && process.stdout.isTTY) {
		throw new BasepadError(
			"With no file, `db export` writes the dump to standard output, which is a terminal here. Name a file, or redirect it: `basepad db export > db.dump`.",
		);
	}
	const say = given === undefined ? (line: string) => console.error(line) : invocation.print;
	const target = await databaseAt({ ...invocation, print: say });
	const { key, service, place, database } = target;
	const file = given === undefined ? undefined : resolve(invocation.cwd, given);
	const hook = dbHooks(target, "Export", say, { BASEPAD_FILE: file ?? "" });
	const format = await database.export(service, place, file, () => hook("before"));
	if (file !== undefined) invocation.print(`Exported \`${key}\` to ${file} as ${format}.`);
	await hook("after");
}
