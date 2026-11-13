import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { kindOf, type Place } from "./catalogue.ts";
import { CONFIG_FILE, LOCAL_FILE, loadProject, type Project } from "./config.ts";
import { writeEnvFiles } from "./env-files.ts";
import type { EnvFiles, Service, ServiceOutputs } from "./index.ts";
import { BasepadError, shellQuote } from "./internal/exec.ts";
import { table } from "./internal/table.ts";
import { type Layout, layout, type Machine, machine } from "./layout.ts";
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

const PACKAGE = "@aysnc-labs/basepad";

async function init({ cwd, print }: Invocation): Promise<void> {
	const file = join(cwd, CONFIG_FILE);
	if (existsSync(file)) {
		throw new BasepadError(`${file} already exists; \`basepad init\` leaves it as it is.`);
	}
	const name = labelOf(basename(cwd));
	await writeFile(file, starter(name));
	print(`Wrote ${CONFIG_FILE} with name "${name}".`);
	if (await ignoreLocalFile(cwd)) print(`Added ${LOCAL_FILE} to .gitignore.`);
	if (await addDevDependency(cwd)) {
		print(
			`Added ${PACKAGE} to devDependencies in package.json; install it with your package manager.`,
		);
	}
}

/** A folder's name as a lowercase DNS label. Never truncated: `status` says when it is too long. */
function labelOf(folder: string): string {
	const label = folder
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return label || "project";
}

function starter(name: string): string {
	return `import { defineConfig } from "${PACKAGE}";

export default defineConfig({
	name: ${JSON.stringify(name)},
	// services: {
	// 	db: postgres({ version: 18 }), // import postgres from "${PACKAGE}" too
	// },
	apps: {
		// web: { run: "npm run dev" }, // https://web.${name}.localhost
	},
	// env: ({ db, web }) => ({
	// 	".env.local": { DATABASE_URL: db.url, APP_URL: web.url },
	// }),
});
`;
}

/** Adds the local file to `.gitignore`, creating it. Returns whether it changed anything. */
async function ignoreLocalFile(cwd: string): Promise<boolean> {
	const file = join(cwd, ".gitignore");
	const text = await readFile(file, "utf8").catch(() => "");
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	if (lines.includes(LOCAL_FILE) || lines.includes(`/${LOCAL_FILE}`)) return false;
	const gap = text === "" || text.endsWith("\n") ? "" : "\n";
	await writeFile(file, `${text}${gap}${LOCAL_FILE}\n`);
	return true;
}

/** Adds basepad to `package.json`'s devDependencies when the file exists and lacks it. */
async function addDevDependency(cwd: string): Promise<boolean> {
	const file = join(cwd, "package.json");
	const text = await readFile(file, "utf8").catch(() => undefined);
	if (text === undefined) return false;
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new BasepadError(`${file} is not valid JSON: ${(error as Error).message}`);
	}
	const has = (field: string) =>
		typeof pkg[field] === "object" && pkg[field] !== null && PACKAGE in (pkg[field] as object);
	if (has("dependencies") || has("devDependencies")) return false;
	pkg.devDependencies = {
		...(pkg.devDependencies as object | undefined),
		[PACKAGE]: `^${await ownVersion()}`,
	};
	const indent = /^[ \t]+/m.exec(text)?.[0] ?? "\t";
	await writeFile(file, `${JSON.stringify(pkg, null, indent)}\n`);
	return true;
}

async function ownVersion(): Promise<string> {
	const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
	return (JSON.parse(text) as { version: string }).version;
}

/** How long `up` waits for apps to listen or fail before it shows their state and returns. */
const APP_WAIT_MS = 5000;
/** How many of a failed app's last lines `up` shows. */
const FAILED_LINES = 20;

async function up({ cwd, flags, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const here = machine(process.env);
	const lay = layout(project, here);
	const services = Object.keys(project.services);
	const apps = Object.keys(project.apps);
	const daemons: Record<string, Daemon> = {};
	for (const key of services) {
		const service = project.services[key] as Service;
		daemons[key] = await kindOf(service).prepare(service, placeOf(project, lay, here, key));
	}
	for (const [key, app] of Object.entries(project.apps)) {
		daemons[key] = {
			run: withLocalBins(project, app.cwd, app.run),
			dir: app.cwd,
			port: lay.apps[key]?.port,
		};
	}
	const supervisor = await openSupervisor(here);
	await supervisor.register({
		namespace: project.name,
		dir: project.root,
		definitions: lay.definitions,
		daemons,
	});
	const since = new Date(Date.now() - 1000);
	const outputs: Record<string, ServiceOutputs | { url: string }> = {};
	if (services.length > 0) {
		const states = await supervisor.start(project.name, services, APP_WAIT_MS);
		const failed = services.filter((key) => states[key] === "failed");
		if (failed.length > 0)
			throw new BasepadError(await failures(supervisor, project, failed, since));
		for (const key of services) {
			const service = project.services[key] as Service;
			outputs[key] = await kindOf(service).provision(service, placeOf(project, lay, here, key), {
				claim: flags.claim === true,
			});
		}
	}
	for (const [key, app] of Object.entries(lay.apps)) outputs[key] = { url: app.url };
	await writeEnvFiles(project.root, envFiles(project, outputs));
	const states = await supervisor.start(project.name, apps, APP_WAIT_MS);
	print(await stateTables(project, lay, here, states));
	const failed = apps.filter((key) => states[key] === "failed");
	if (failed.length > 0) throw new BasepadError(await failures(supervisor, project, failed, since));
}

/** Where one of the project's services lives. */
function placeOf(project: Project, lay: Layout, here: Machine, key: string): Place {
	const service = lay.services[key] as Layout["services"][string];
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
	const lay = layout(project, here);
	if (Object.keys(lay.apps).length === 0 && Object.keys(project.services).length === 0) {
		print(`${project.file} names no apps or services.`);
		return;
	}
	const supervisor = await openSupervisor(here);
	print(await stateTables(project, lay, here, await supervisor.status(project.name)));
}
