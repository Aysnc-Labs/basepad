import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { CONFIG_FILE, LOCAL_FILE, loadProject, type Project } from "./config.ts";
import { writeEnvFiles } from "./env-files.ts";
import type { EnvFiles } from "./index.ts";
import { BasepadError, shellQuote } from "./internal/exec.ts";
import { table } from "./internal/table.ts";
import { type Layout, layout, machine } from "./layout.ts";
import { type DaemonState, openSupervisor, type Supervisor } from "./supervisor.ts";

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
		summary: "Start this project's apps, set its env files and show their state",
		flags: {
			detach: { short: "d", description: "Accepted for Docker habits; `up` always returns" },
		},
		run: up,
	},
	down: {
		summary: "Stop this project's apps; nothing is deleted",
		flags: {},
		run: down,
	},
	status: {
		summary: "Show each app with its address and state",
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

async function up({ cwd, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const services = Object.keys(project.services);
	if (services.length > 0) {
		throw new BasepadError(
			`${project.file}: \`basepad up\` does not run services yet; remove ${services.map((s) => `\`${s}\``).join(", ")} from \`services\`.`,
		);
	}
	const here = machine(process.env);
	const lay = layout(project, here);
	await writeEnvFiles(project.root, envFiles(project, lay));
	const supervisor = await openSupervisor(here);
	await supervisor.register({
		namespace: project.name,
		dir: project.root,
		definitions: lay.definitions,
		daemons: Object.fromEntries(
			Object.entries(project.apps).map(([key, app]) => [
				key,
				{ run: withLocalBins(project, app.cwd, app.run), dir: app.cwd, port: lay.apps[key]?.port },
			]),
		),
	});
	const since = new Date(Date.now() - 1000);
	const states = await supervisor.start(project.name, Object.keys(project.apps), APP_WAIT_MS);
	print(appTable(lay, states));
	const failed = Object.keys(project.apps).filter((key) => states[key] === "failed");
	if (failed.length > 0) throw new BasepadError(await failures(supervisor, project, failed, since));
}

/** Runs the config's `env` with each app's URL, and checks what it returns. */
function envFiles(project: Project, lay: Layout): EnvFiles {
	const outputs = Object.fromEntries(
		Object.entries(lay.apps).map(([key, app]) => [key, { url: app.url }]),
	);
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

function appTable(lay: Layout, states: Record<string, DaemonState>): string {
	const rows = Object.entries(lay.apps).map(([key, app]) => [
		key,
		app.url,
		states[key] ?? "stopped",
	]);
	return table([["APP", "URL", "STATE"], ...rows]);
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
	print(`Stopped ${project.name}'s apps.`);
}

async function status({ cwd, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const here = machine(process.env);
	const lay = layout(project, here);
	if (Object.keys(lay.apps).length === 0) {
		print(`${project.file} names no apps.`);
		return;
	}
	const supervisor = await openSupervisor(here);
	print(appTable(lay, await supervisor.status(project.name)));
}
