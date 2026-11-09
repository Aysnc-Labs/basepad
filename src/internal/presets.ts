import type { NeonProxy } from "./neon.ts";
import type { PostgresServer } from "./postgres.ts";
import type { Project, Service } from "./records.ts";

/** A preset picks the framework's env file and its variable names. */
export const PRESETS = ["next"] as const;
export type Preset = (typeof PRESETS)[number];

const FILES: Record<Preset, string> = { next: ".env.local" };

/**
 * A service's database variable: `DATABASE_URL` under its default name (`postgres`,
 * `postgres-neon`), else `<NAME>_DATABASE_URL`.
 */
export function databaseVar(name: string, service: Pick<Service, "type">): string {
	return name === service.type
		? "DATABASE_URL"
		: `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DATABASE_URL`;
}

/** Where Neon's driver finds the proxy (`neonConfig.wsProxy`). One per machine, so it's unprefixed. */
export const NEON_WS_PROXY_VAR = "NEON_WS_PROXY";

/** The env file a project's preset uses, and the variables basepad writes into its block. */
export function envVars(
	project: Project,
	server: PostgresServer,
	neon: NeonProxy | undefined,
): { file: string; vars: Record<string, string> } {
	const vars: Record<string, string> = {};
	for (const [name, service] of Object.entries(project.services)) {
		if (service.type === "postgres-neon") {
			if (!neon) throw new Error(`${name} needs the Neon proxy, which isn't started.`);
			vars[databaseVar(name, service)] = neon.url(service.database);
			vars[NEON_WS_PROXY_VAR] = neon.wsProxy;
		} else {
			vars[databaseVar(name, service)] = server.url(service.database);
		}
	}
	return { file: FILES[project.preset], vars };
}
