import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeEnvBlock } from "./envfile.ts";
import { BasepadError } from "./exec.ts";
import { withHome } from "./home.ts";
import { daemons } from "./mise.ts";
import { startPostgres } from "./postgres.ts";
import { envVars, PRESETS, type Preset } from "./presets.ts";
import { writeProjectConfig } from "./project.ts";

export const SERVICES = ["postgres"] as const;

export interface AddOptions {
	cwd: string;
	service: string;
	name?: string;
	preset?: string;
}

/** `basepad add`: a service for the project in `cwd`, running, with its variables in the env file. */
export async function add(options: AddOptions): Promise<string[]> {
	if (!(SERVICES as readonly string[]).includes(options.service)) {
		throw new BasepadError(
			`Unknown service \`${options.service}\`. basepad can add: ${SERVICES.join(", ")}.`,
		);
	}
	const name = options.name ?? options.service;
	if (!/^[a-z][a-z0-9_-]*$/.test(name) || name.includes("--")) {
		throw new BasepadError(
			`\`${name}\` isn't a valid service name: use lowercase letters, digits, \`-\` and \`_\`, starting with a letter.`,
		);
	}
	if (options.preset !== undefined && !(PRESETS as readonly string[]).includes(options.preset)) {
		throw new BasepadError(`Unknown preset \`${options.preset}\`. Presets: ${PRESETS.join(", ")}.`);
	}

	const projectDir = await realpath(options.cwd);
	const lines = await withHome(async (home) => {
		const project = home.records.projects[projectDir] ?? { preset: "next", services: {} };
		home.records.projects[projectDir] = project;
		if (options.preset) project.preset = options.preset as Preset;

		const server = await startPostgres(home);
		const existing = project.services[name];
		const database = existing?.database ?? databaseName(home.records.projects, projectDir, name);
		project.services[name] = { type: "postgres", database };
		await server.ensureDatabase(database);
		await home.save();

		await writeProjectConfig(projectDir, project, home);
		const { file, vars } = envVars(project, server);
		await writeEnvBlock(join(projectDir, file), vars);
		return [
			`Added ${name}: database ${database} on the shared Postgres (port ${server.port}).`,
			`Wrote ${file}.`,
		];
	});
	if ((await daemons(projectDir)) === undefined) {
		lines.push(
			"This project's mise config isn't trusted yet. Review it, then run `mise trust` so `mise daemons start` can start its services.",
		);
	}
	return lines;
}

/**
 * The project's database for a service: the project's directory name, plus the service's name
 * when it isn't the default, made unique across every project basepad knows.
 */
function databaseName(
	projects: Record<string, { services: Record<string, { database: string }> }>,
	projectDir: string,
	name: string,
): string {
	const base = sanitise(
		name === "postgres" ? basename(projectDir) : `${basename(projectDir)}_${name}`,
	);
	const taken = new Set(
		Object.values(projects).flatMap((p) => Object.values(p.services).map((s) => s.database)),
	);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** A Postgres identifier that needs no quoting: lowercase letters, digits and `_`, at most 50 long. */
function sanitise(raw: string): string {
	const name = raw
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 50);
	return /^[a-z]/.test(name) ? name : `db_${name}`;
}
