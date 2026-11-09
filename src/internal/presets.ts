import type { PostgresServer } from "./postgres.ts";
import type { Project } from "./records.ts";

/** A preset picks the framework's env file and its variable names. */
export const PRESETS = ["next"] as const;
export type Preset = (typeof PRESETS)[number];

const FILES: Record<Preset, string> = { next: ".env.local" };

/** The env file a project's preset uses, and the variables basepad writes into its block. */
export function envVars(
	project: Project,
	server: PostgresServer,
): { file: string; vars: Record<string, string> } {
	const vars: Record<string, string> = {};
	for (const [name, service] of Object.entries(project.services)) {
		const key =
			name === "postgres"
				? "DATABASE_URL"
				: `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DATABASE_URL`;
		vars[key] = server.url(service.database);
	}
	return { file: FILES[project.preset], vars };
}
