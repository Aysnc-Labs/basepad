import { basename, join } from "node:path";
import {
	CONFIG_FILE,
	hasConfig,
	loadConfig,
	type ProjectConfig,
	type ServiceConfig,
} from "./config.ts";
import { writeEnvBlock } from "./envfile.ts";
import { BasepadError } from "./exec.ts";
import { type Home, withHome } from "./home.ts";
import { MAILPIT_DAEMON, type MailServer, mailTag, startMailpit } from "./mailpit.ts";
import { daemons } from "./mise.ts";
import { appDaemon, ensureProxy, labelWorktree } from "./names.ts";
import { NEON_PROXY_DAEMON, type NeonProxy, startNeonProxy } from "./neon.ts";
import { freePort } from "./ports.ts";
import { POSTGRES_DAEMON, type PostgresServer, startPostgres } from "./postgres.ts";
import { ENV_FILES, NEON_WS_PROXY_VAR, needsAppPort, presetVars } from "./presets.ts";
import { referenceTable, writeProjectConfig } from "./project.ts";
import type { Project } from "./records.ts";
import { redisDaemon, redisPort, redisUrl, startRedis } from "./redis.ts";
import { worktreeDatabases, worktreeRedis } from "./worktree-data.ts";

/** Where an app's port search starts: the usual dev-server port. */
const APP_PORT_BASE = 8000;

/**
 * `basepad up`: brings the project in `projectDir` in line with its `basepad.toml`. Starts its
 * services (the shared ones in the home project, its own Redis), creates its databases, rewrites
 * its conf.d file and its env block. Safe to run again: what exists is kept.
 */
export async function up(projectDir: string): Promise<string[]> {
	if (!(await hasConfig(projectDir))) {
		throw new BasepadError(`No ${CONFIG_FILE} here. Add a service with \`basepad add <service>\`.`);
	}
	return withHome(async (home) => (await bringUp(home, projectDir)).lines);
}

export interface Up {
	lines: string[];
	/** The env block as written: every variable, under the names the app reads. */
	vars: Record<string, string>;
	project: Project;
}

/**
 * `up`'s work, with the home already held. A project with no `basepad.toml` has no services, but
 * a worktree still gets its port. In a worktree, each service follows its `copy` strategy.
 */
export async function bringUp(home: Home, projectDir: string): Promise<Up> {
	const config = await loadConfig(projectDir);
	const project: Project = home.records.projects[projectDir] ?? { services: {} };
	home.records.projects[projectDir] = project;
	const worktree = project.worktree;
	// Before any daemon starts: pitchfork's supervisor reads its proxy settings once.
	await ensureProxy(home);
	if (worktree) await labelWorktree(home, worktree);
	const lines: string[] = [];
	const tables: string[] = [];
	const vars = new Vars();
	const own: { name: string; port: number }[] = [];
	let postgres: PostgresServer | undefined;
	let mailpit: MailServer | undefined;
	let neon: NeonProxy | undefined;

	for (const service of config.services) {
		switch (service.type) {
			case "postgres": {
				postgres ??= await startPostgres(home);
				const databases = await ensureDatabases(
					home,
					projectDir,
					project,
					service,
					postgres,
					lines,
				);
				for (const [key, database] of databases) vars.set(key, postgres.url(database), service);
				tables.push(referenceTable(service.name, home, POSTGRES_DAEMON));
				lines.push(
					`${service.name}: ${databases.map(([, db]) => `database ${db}`).join(", ")} on the shared Postgres (port ${postgres.port}).`,
				);
				break;
			}
			case "postgres-neon": {
				postgres ??= await startPostgres(home);
				// Started once Postgres accepts queries, since it reads its allow-list from there.
				neon ??= await startNeonProxy(home, postgres);
				const databases = await ensureDatabases(
					home,
					projectDir,
					project,
					service,
					postgres,
					lines,
				);
				for (const [key, database] of databases) vars.set(key, neon.url(database), service);
				tables.push(referenceTable(service.name, home, POSTGRES_DAEMON));
				lines.push(
					`${service.name}: ${databases.map(([, db]) => `database ${db}`).join(", ")} on the shared Postgres (port ${postgres.port}), through the shared Neon proxy (${neon.wsProxy}).`,
				);
				break;
			}
			case "mailpit": {
				mailpit ??= await startMailpit(home);
				project.services[service.name] = { type: "mailpit" };
				const tag = mailTag(worktree?.name ?? basename(projectDir));
				vars.set(urlKey(service, "SMTP_URL"), mailpit.smtpUrl(tag), service);
				tables.push(referenceTable(service.name, home, MAILPIT_DAEMON));
				lines.push(
					`${service.name}: mail tagged ${tag} in the shared Mailpit, inbox at ${mailpit.inbox}.`,
				);
				break;
			}
			case "redis": {
				const existing = project.services[service.name];
				const chosen = worktree
					? await worktreeRedis(home, project, worktree, service)
					: {
							port: existing?.type === "redis" ? existing.port : await redisPort(home),
							own: true,
						};
				if (chosen === undefined) {
					lines.push(`${service.name}: main has no Redis to share; run \`basepad up\` in main.`);
					break;
				}
				const { port } = chosen;
				if (!worktree) project.services[service.name] = { type: "redis", port };
				await home.save();
				vars.set(urlKey(service, "REDIS_URL"), redisUrl(port), service);
				if (!chosen.own) {
					lines.push(`${service.name}: main's Redis, shared (port ${port}).`);
					break;
				}
				tables.push(await redisDaemon(home, service.name, port));
				own.push({ name: service.name, port });
				lines.push(`${service.name}: this project's own Redis (port ${port}).`);
				break;
			}
		}
	}

	if (neon) {
		// One proxy serves every database, so the project gets one variable and one reference.
		vars.set(NEON_WS_PROXY_VAR, neon.wsProxy, { name: NEON_PROXY_DAEMON });
		tables.push(referenceTable(NEON_PROXY_DAEMON, home, NEON_PROXY_DAEMON));
	}
	if (worktree || needsAppPort(config.preset) || config.app) {
		project.app ??= { port: await freePort(APP_PORT_BASE, home.records) };
	}
	if (config.app && project.app) tables.push(appDaemon(config.app.run, project.app.port));
	await home.save();
	await writeProjectConfig(projectDir, tables);
	// After the conf.d file, which turns on mise's daemons for the project.
	const trusted = (await daemons(projectDir)) !== undefined;

	if (trusted) {
		for (const { name, port } of own) await startRedis(projectDir, name, port);
	} else if (own.length > 0) {
		lines.push(
			`This project's mise config isn't trusted, so ${own.map((d) => d.name).join(", ")} didn't start. Review it, run \`mise trust\`, then \`mise daemons start\`.`,
		);
	} else if (config.services.length > 0) {
		lines.push(
			"This project's mise config isn't trusted yet. Review it, then run `mise trust` so `mise daemons start` can start its services.",
		);
	}

	const file = ENV_FILES[config.preset];
	const preset = presetVars(config.preset, vars.all, project.app?.port);
	// A worktree's app server needs its own port; Laravel's preset names it SERVER_PORT.
	if (worktree && project.app && config.preset === "next") preset.PORT = String(project.app.port);
	const written = rename(preset, config, lines);
	await writeEnvBlock(join(projectDir, file), written);
	lines.push(`Wrote ${file}.`);
	return { lines, vars: written, project };
}

/** A service's variables follow its name: `<NAME>_URL`, or the usual name when it's the default. */
function urlKey(service: ServiceConfig, usual: string): string {
	return service.name === service.type ? usual : `${envName(service.name)}_URL`;
}

/** A Postgres database's variable: `DATABASE_URL` for the default service, else `<NAME>_DATABASE_URL`. */
function databaseKey(service: ServiceConfig, database: string): string {
	if (service.databases === undefined && service.name === service.type) return "DATABASE_URL";
	return `${envName(database)}_DATABASE_URL`;
}

function envName(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** Creates the service's databases unless they exist; returns each one's variable and its name. */
async function ensureDatabases(
	home: Home,
	projectDir: string,
	project: Project,
	service: ServiceConfig,
	server: PostgresServer,
	lines: string[],
): Promise<[string, string][]> {
	if (project.worktree) {
		const databases = await worktreeDatabases(
			home,
			project,
			project.worktree,
			service,
			server,
			lines,
		);
		return databases.map(([database, name]) => [databaseKey(service, database), name]);
	}
	const existing = project.services[service.name];
	const type = service.type as "postgres" | "postgres-neon";
	const databases = existing?.type === type ? existing.databases : {};
	project.services[service.name] = { type, databases };
	const out: [string, string][] = [];
	for (const database of service.databases ?? [service.name]) {
		databases[database] ??= databaseName(home, projectDir, service, database);
		await home.save();
		await server.ensureDatabase(databases[database]);
		out.push([databaseKey(service, database), databases[database]]);
	}
	return out;
}

/**
 * A database's name in Postgres: the project's directory name, plus the database's own name
 * unless it's the project's default, made unique across every project basepad knows.
 */
function databaseName(
	home: Home,
	projectDir: string,
	service: ServiceConfig,
	database: string,
): string {
	const plain = service.databases === undefined && service.name === service.type;
	const base = sanitise(plain ? basename(projectDir) : `${basename(projectDir)}_${database}`);
	const taken = new Set(
		Object.values(home.records.projects).flatMap((p) =>
			Object.values(p.services).flatMap((s) =>
				s.type === "postgres" || s.type === "postgres-neon" ? Object.values(s.databases) : [],
			),
		),
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

/** The env block's variables, refusing two services that would write the same one. */
class Vars {
	readonly all: Record<string, string> = {};
	private readonly owners = new Map<string, string>();

	set(key: string, value: string, service: { name: string }): void {
		const owner = this.owners.get(key);
		if (owner !== undefined && owner !== service.name) {
			throw new BasepadError(
				`Services \`${owner}\` and \`${service.name}\` would both write ${key}. Rename one of their databases or services.`,
			);
		}
		this.owners.set(key, service.name);
		this.all[key] = value;
	}
}

/** Applies the config's renames, keeping each variable's place in the block. */
function rename(
	vars: Record<string, string>,
	config: ProjectConfig,
	lines: string[],
): Record<string, string> {
	const targets = new Map<string, string>();
	for (const [from, to] of Object.entries(config.rename)) {
		const other = targets.get(to);
		if (other !== undefined) {
			throw new BasepadError(`basepad.toml renames both ${other} and ${from} to ${to}.`);
		}
		targets.set(to, from);
		if (!(from in vars)) {
			lines.push(`basepad.toml renames ${from}, which basepad doesn't write; ignored.`);
		} else if (to !== from && to in vars) {
			throw new BasepadError(
				`basepad.toml renames ${from} to ${to}, which basepad already writes.`,
			);
		}
	}
	return Object.fromEntries(
		Object.entries(vars).map(([key, value]) => [config.rename[key] ?? key, value]),
	);
}
