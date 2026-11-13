import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CONFIG_FILE, LOCAL_FILE, loadProject } from "./config.ts";
import { BasepadError } from "./internal/exec.ts";
import { table } from "./internal/table.ts";
import { layout, machine } from "./layout.ts";

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

async function status({ cwd, print }: Invocation): Promise<void> {
	const project = await loadProject(cwd);
	const { apps } = layout(project, machine(process.env));
	const rows = Object.entries(apps).map(([key, app]) => [key, app.url, "stopped"]);
	if (rows.length === 0) {
		print(`${project.file} names no apps.`);
		return;
	}
	print(table([["APP", "URL", "STATE"], ...rows]));
}
