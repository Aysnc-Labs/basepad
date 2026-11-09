import type { ServiceConfig } from "./config.ts";
import type { Home } from "./home.ts";
import type { PostgresServer } from "./postgres.ts";
import { databasesOf, type Project, type Worktree } from "./records.ts";
import { redisPort } from "./redis.ts";

/** Postgres's limit on an identifier. */
const MAX_IDENTIFIER = 63;

/**
 * A worktree's databases for a Postgres service (`postgres` or `postgres-neon`), as its `copy` strategy says: `copy` makes
 * `<main's db>_<worktree>` from main's, `empty` makes it empty, and `shared` uses main's own.
 * Returns each database's config name and its name in Postgres, and records them on `project`.
 */
export async function worktreeDatabases(
	home: Home,
	project: Project,
	worktree: Worktree,
	service: ServiceConfig,
	server: PostgresServer,
	lines: string[],
): Promise<[string, string][]> {
	const type = service.type as "postgres" | "postgres-neon";
	const main = home.records.projects[worktree.main]?.services[service.name];
	const mainDatabases = main?.type === type ? main.databases : {};
	const existing = project.services[service.name];
	const databases = existing?.type === type ? existing.databases : {};
	const out: [string, string][] = [];

	if (service.copy === "shared") {
		project.services[service.name] = {
			type,
			databases: { ...mainDatabases },
			shared: true,
		};
		await home.save();
		for (const database of service.databases ?? [service.name]) {
			const name = mainDatabases[database];
			if (name !== undefined) out.push([database, name]);
		}
		return out;
	}

	project.services[service.name] = { type, databases };
	for (const database of service.databases ?? [service.name]) {
		const from = mainDatabases[database];
		databases[database] ??= worktreeDatabaseName(home, from ?? database, worktree.name);
		await home.save();
		const name = databases[database];
		out.push([database, name]);
		if (await server.hasDatabase(name)) continue;
		if (service.copy === "copy" && from !== undefined && (await server.hasDatabase(from))) {
			const how = await server.copyDatabase(from, name);
			lines.push(
				how === "template"
					? `${service.name}: copied ${from} to ${name} (template copy).`
					: `${service.name}: copied ${from} to ${name} (dump and restore, since main's database is in use).`,
			);
		} else {
			await server.ensureDatabase(name);
			lines.push(`${service.name}: created ${name}, empty.`);
		}
	}
	return out;
}

/**
 * A worktree's Redis for a service: its own on a new port (`empty`), or main's (`shared`), which
 * the worktree never starts or stops. Returns the port and whether the worktree owns it.
 */
export async function worktreeRedis(
	home: Home,
	project: Project,
	worktree: Worktree,
	service: ServiceConfig,
): Promise<{ port: number; own: boolean } | undefined> {
	if (service.copy === "shared") {
		const main = home.records.projects[worktree.main]?.services[service.name];
		if (main?.type !== "redis") return undefined;
		project.services[service.name] = { type: "redis", port: main.port, shared: true };
		return { port: main.port, own: false };
	}
	const existing = project.services[service.name];
	const port =
		existing?.type === "redis" && !existing.shared ? existing.port : await redisPort(home);
	project.services[service.name] = { type: "redis", port };
	return { port, own: true };
}

/** `<db>_<worktree>`, cut to Postgres's limit and made unique across every project basepad knows. */
function worktreeDatabaseName(home: Home, database: string, worktree: string): string {
	const suffix = worktree
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	const base = `${database}_${suffix}`.slice(0, MAX_IDENTIFIER - 3);
	const taken = new Set(
		Object.values(home.records.projects).flatMap((p) =>
			Object.values(p.services).flatMap((s) => databasesOf(s)),
		),
	);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}
