import { basename, join } from "node:path";
import { loadConfig, type ProjectConfig, type ServiceConfig } from "./config.ts";
import { writeEnvBlock } from "./envfile.ts";
import { BasepadError } from "./exec.ts";
import { type Home, withHome } from "./home.ts";
import { MAILPIT_DAEMON, type MailServer, mailTag, startMailpit } from "./mailpit.ts";
import { daemons } from "./mise.ts";
import { freePort } from "./ports.ts";
import { POSTGRES_DAEMON, type PostgresServer, startPostgres } from "./postgres.ts";
import { ENV_FILES, needsAppPort, presetVars } from "./presets.ts";
import { referenceTable, writeProjectConfig } from "./project.ts";
import type { Project } from "./records.ts";
import { redisDaemon, redisPort, redisUrl, startRedis } from "./redis.ts";

/** Where an app's port search starts: the usual dev-server port. */
const APP_PORT_BASE = 8000;

/**
 * `basepad up`: brings the project in `projectDir` in line with its `basepad.toml`. Starts its
 * services (the shared ones in the home project, its own Redis), creates its databases, rewrites
 * its conf.d file and its env block. Safe to run again: what exists is kept.
 */
export async function up(projectDir: string): Promise<string[]> {
	const config = await loadConfig(projectDir);
	return withHome(async (home) => {
		const project: Project = home.records.projects[projectDir] ?? { services: {} };
		home.records.projects[projectDir] = project;
		const lines: string[] = [];
		const tables: string[] = [];
		const vars = new Vars();
		const own: { name: string; port: number }[] = [];
		let postgres: PostgresServer | undefined;
		let mailpit: MailServer | undefined;

		for (const service of config.services) {
			switch (service.type) {
				case "postgres": {
					postgres ??= await startPostgres(home);
					const databases = await ensureDatabases(home, projectDir, project, service, postgres);
					for (const [key, database] of databases) vars.set(key, postgres.url(database), service);
					tables.push(referenceTable(service.name, home, POSTGRES_DAEMON));
					lines.push(
						`${service.name}: ${databases.map(([, db]) => `database ${db}`).join(", ")} on the shared Postgres (port ${postgres.port}).`,
					);
					break;
				}
				case "mailpit": {
					mailpit ??= await startMailpit(home);
					project.services[service.name] = { type: "mailpit" };
					const tag = mailTag(basename(projectDir));
					vars.set(urlKey(service, "SMTP_URL"), mailpit.smtpUrl(tag), service);
					tables.push(referenceTable(service.name, home, MAILPIT_DAEMON));
					lines.push(
						`${service.name}: mail tagged ${tag} in the shared Mailpit, inbox at ${mailpit.inbox}.`,
					);
					break;
				}
				case "redis": {
					const existing = project.services[service.name];
					const port = existing?.type === "redis" ? existing.port : await redisPort(home);
					project.services[service.name] = { type: "redis", port };
					await home.save();
					tables.push(await redisDaemon(home, service.name, port));
					vars.set(urlKey(service, "REDIS_URL"), redisUrl(port), service);
					own.push({ name: service.name, port });
					lines.push(`${service.name}: this project's own Redis (port ${port}).`);
					break;
				}
			}
		}

		if (needsAppPort(config.preset)) {
			project.app ??= { port: await freePort(APP_PORT_BASE, home.records) };
		}
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
		const written = rename(presetVars(config.preset, vars.all, project.app?.port), config, lines);
		await writeEnvBlock(join(projectDir, file), written);
		lines.push(`Wrote ${file}.`);
		return lines;
	});
}

/** A service's variables follow its name: `<NAME>_URL`, or the usual name when it's the default. */
function urlKey(service: ServiceConfig, usual: string): string {
	return service.name === service.type ? usual : `${envName(service.name)}_URL`;
}

/** A Postgres database's variable: `DATABASE_URL` for the default service, else `<NAME>_DATABASE_URL`. */
function databaseKey(service: ServiceConfig, database: string): string {
	if (service.databases === undefined && service.name === "postgres") return "DATABASE_URL";
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
): Promise<[string, string][]> {
	const existing = project.services[service.name];
	const databases = existing?.type === "postgres" ? existing.databases : {};
	project.services[service.name] = { type: "postgres", databases };
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
	const plain = service.databases === undefined && service.name === "postgres";
	const base = sanitise(plain ? basename(projectDir) : `${basename(projectDir)}_${database}`);
	const taken = new Set(
		Object.values(home.records.projects).flatMap((p) =>
			Object.values(p.services).flatMap((s) =>
				s.type === "postgres" ? Object.values(s.databases) : [],
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

	set(key: string, value: string, service: ServiceConfig): void {
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
