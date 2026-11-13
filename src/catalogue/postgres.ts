import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Kind } from "../catalogue.ts";
import { BasepadError, must, shellQuote } from "../internal/exec.ts";
import { freePort, waitFor } from "../internal/ports.ts";
import { serviceUser } from "../internal/service-user.ts";
import { install, type Tool } from "../tools.ts";
import { PGVECTOR_VERSIONS } from "../versions.ts";

/**
 * A Postgres server of the environment's own: mise's Postgres with pgvector placed in it, its data
 * in the home, on loopback only, trust auth, no unix socket. Each database carries its owner
 * checkout's path as its comment, so a second checkout under the same name is refused.
 */

const HOST = "127.0.0.1";
const USER = "postgres";
/** For client libraries that insist on a password; the server trusts loopback and ignores it. */
const PASSWORD = "basepad";
/** How long `up` waits for the server to answer before it gives up. */
const READY_MS = 60_000;

export type PostgresVersion = 17 | 18;

/**
 * What a worktree's database starts as: a copy of main's data, empty, or main's own database
 * (`shared`, which a worktree never drops).
 */
export type PostgresWorktree = "copy" | "empty" | "shared";

/** A Postgres server of the project's own, with one database for this service. */
export interface PostgresService {
	kind: "postgres";
	version: PostgresVersion;
	worktree: PostgresWorktree;
}

/**
 * A Postgres server of the project's own. `version` is 17 or 18; it defaults to 18. `worktree` is
 * what a worktree's database starts as; it defaults to `copy`.
 */
export function postgres(
	options: { version?: PostgresVersion; worktree?: PostgresWorktree } = {},
): PostgresService {
	return { kind: "postgres", version: options.version ?? 18, worktree: options.worktree ?? "copy" };
}

/** What a Postgres service gives to `env`. The password is a placeholder: local connections are trusted. */
export interface PostgresOutputs {
	url: string;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

/** The names a Postgres service derives. */
export interface PostgresNames {
	/**
	 * The environment's database: `<name>_<key>` in main, `<name>_<key>_<suffix>` in a worktree
	 * (main's when the service is `shared`), hyphens made underscores.
	 */
	database: string;
	/** Main's database, which a worktree's is made from. */
	main: string;
	/** The server's data folder, in the service's folder. */
	data: string;
}

/** Postgres silently truncates identifiers past this many bytes. */
const IDENTIFIER_MAX = 63;

export const postgresKind: Kind<PostgresService, PostgresOutputs, PostgresNames> = {
	schema: z.strictObject({
		kind: z.literal("postgres"),
		version: z.union([z.literal(17), z.literal(18)], {
			error: "Postgres version must be 17 or 18",
		}),
		worktree: z.enum(["copy", "empty", "shared"], {
			error: "Postgres `worktree` must be copy, empty or shared",
		}),
	}),

	names(service, { name, key, dir, suffix }) {
		const main = `${name}_${key}`.replaceAll("-", "_");
		const mainBytes = Buffer.byteLength(main);
		if (mainBytes > IDENTIFIER_MAX) {
			throw new BasepadError(
				`\`name\` and service \`${key}\` make the database name "${main}", which is ${mainBytes} bytes; Postgres allows ${IDENTIFIER_MAX}. Shorten \`name\` or the service key.`,
			);
		}
		const own = suffix !== undefined && service.worktree !== "shared";
		const database = own ? `${main}_${suffix.replaceAll("-", "_")}` : main;
		const bytes = Buffer.byteLength(database);
		if (bytes > IDENTIFIER_MAX) {
			throw new BasepadError(
				`service \`${key}\` makes a worktree's database name "${database}", which is ${bytes} bytes; Postgres allows ${IDENTIFIER_MAX}.`,
			);
		}
		return { database, main, data: join(dir, "data") };
	},

	async prepare(service, place) {
		const pg = await installPostgres(service.version, place.machine.home);
		const user = await serviceUser();
		const { data } = place;
		await mkdir(place.dir, { recursive: true });
		await user.grant({ traverse: [pg.dir, place.dir], owned: [place.dir] });
		const initialised = await readFile(join(data, "PG_VERSION"), "utf8").catch(() => undefined);
		if (initialised === undefined) {
			// A half-made folder from an initdb that failed; initdb refuses one that isn't empty.
			await rm(data, { recursive: true, force: true });
			const argv = user.wrap([
				pg.bin("initdb"),
				"-D",
				data,
				"-U",
				USER,
				"--auth=trust",
				// Pinned, or initdb takes the shell's locale and clusters differ between machines.
				"--encoding=UTF8",
				"--locale-provider=builtin",
				"--locale=C.UTF-8",
			]);
			await must(argv[0] as string, argv.slice(1));
		} else if (initialised.trim() !== String(service.version)) {
			throw new BasepadError(
				`\`${place.key}\` asks for Postgres ${service.version}, but its data in ${data} is Postgres ${initialised.trim()}. Dump it with Postgres ${initialised.trim()}, remove that folder, then run \`basepad up\` again.`,
			);
		}
		const port = (await runningPort(data)) ?? (await freePort(place.port));
		const server = user.wrap([
			pg.bin("postgres"),
			"-D",
			data,
			"-p",
			String(port),
			"-c",
			`listen_addresses=${HOST}`,
			// No unix socket: its path limit and permissions only get in the way; clients use TCP.
			"-c",
			"unix_socket_directories=",
		]);
		return {
			run: `exec ${server.map(shellQuote).join(" ")}`,
			dir: place.dir,
			// Fast shutdown: SIGTERM's smart shutdown would wait for every app's connections to close.
			stopSignal: "SIGINT",
			listens: port,
		};
	},

	async provision(service, place, { claim, stopped, print }) {
		const pg = await installPostgres(service.version, place.machine.home);
		const { data } = place;
		const port = await waitFor(
			async () => {
				const port = await runningPort(data);
				if (port === undefined) throw new Error("It has not started.");
				await query(pg, port, "select 1");
				return port;
			},
			`Postgres for \`${place.key}\` didn't answer within ${READY_MS / 1000} s.`,
			READY_MS,
			stopped,
		);
		const sql = (text: string) => query(pg, port, text);
		const db = place.database;
		const outputs = {
			url: `postgresql://${USER}:${PASSWORD}@${HOST}:${port}/${db}`,
			host: HOST,
			port,
			user: USER,
			password: PASSWORD,
			database: db,
		};
		// A shared worktree database is main's, which main provisions and stamps.
		if (place.suffix !== undefined && service.worktree === "shared") return outputs;
		const open = await sql(`select datallowconn from pg_database where datname = ${literal(db)}`);
		const exists = open !== "";
		// Left closed by a copy that was interrupted.
		if (open === "f") await sql(`alter database ${identifier(db)} allow_connections true`);
		if (!exists && place.suffix !== undefined && service.worktree === "copy") {
			const start = performance.now();
			const route = await copyDatabase(pg, port, place.main, db);
			const seconds = ((performance.now() - start) / 1000).toFixed(1);
			print(`Copied main's \`${place.key}\` by ${route} in ${seconds} s.`);
		} else if (!exists) {
			await sql(`create database ${identifier(db)}`);
		}
		// Creating and stamping are not atomic: an unstamped database is stamped by whoever comes next.
		const stamp = () =>
			sql(
				`select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = ${literal(db)}`,
			);
		const owner = await stamp();
		if (owner !== "" && owner !== place.owner && !claim) {
			throw new BasepadError(
				`The database \`${db}\` belongs to the checkout at ${owner}, which has the same name ("${place.name}"). Two checkouts would share its data, so basepad stops here.\nIf that checkout moved here, or you want this one to take over, run \`basepad up --claim\`.`,
			);
		}
		if (owner !== place.owner) {
			// A comment on a database that has gone is only a warning, so the result is read back.
			await sql(`comment on database ${identifier(db)} is ${literal(place.owner)}`);
			if ((await stamp()) !== place.owner) {
				throw new BasepadError(`Could not mark \`${db}\` as belonging to ${place.owner}.`);
			}
		}
		return outputs;
	},

	async worktreeData(service, place) {
		const port = await runningPort(place.data);
		if (port === undefined) return [];
		const pg = await installPostgres(service.version, place.machine.home);
		const rows = await query(
			pg,
			port,
			`select datname || '|' || coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname like ${literal(`${likeEscaped(place.main)}\\_%`)}`,
		);
		const all = rows
			.split("\n")
			.filter(Boolean)
			.map((row) => {
				const at = row.indexOf("|");
				return { name: row.slice(0, at), owner: row.slice(at + 1) };
			})
			.filter((data) => data.name !== place.main);
		if (place.suffix === undefined) return all;
		return all.filter((data) => data.name === place.database || data.owner === place.owner);
	},

	async dropWorktreeData(service, place, names) {
		if (names.includes(place.main)) {
			throw new BasepadError(`\`${place.main}\` is main's database, which basepad never drops.`);
		}
		const port = await runningPort(place.data);
		if (port === undefined || names.length === 0) return;
		const pg = await installPostgres(service.version, place.machine.home);
		for (const name of names) {
			// A worktree's app may still hold it open; its sessions end with it.
			await query(pg, port, `drop database if exists ${identifier(name)} with (force)`);
		}
	},

	async address(_service, place) {
		const port = (await runningPort(place.data)) ?? place.port;
		return `postgresql://${USER}@${HOST}:${port}/${place.database}`;
	},
};

/**
 * Installs Postgres through mise and places pgvector in it. mise's Postgres is conda-forge's, which
 * lacks pgvector, and Postgres 17 only finds extensions inside its own install, so pgvector's files
 * are copied in. A marker in the install says they are there; a reinstall drops it, and they are
 * copied again.
 */
async function installPostgres(version: PostgresVersion, home: string): Promise<Tool> {
	const pg = await install("postgres", String(version), home);
	const pgvector = PGVECTOR_VERSIONS[version];
	const marker = join(pg.dir, `.basepad-pgvector-${pgvector}`);
	if (existsSync(marker)) return pg;
	const from = (await install("conda:pgvector", pgvector, home)).dir;
	// mise doesn't expose pg_config among the install's programs, so it is found in the install.
	const pgConfig = join(pg.dir, "bin", "pg_config");
	const config = (flag: string) => must(pgConfig, [flag]).then((out) => out.trim());
	const libDir = await config("--pkglibdir");
	const extensionDir = join(await config("--sharedir"), "extension");
	const copies: [string, string][] = [];
	for (const file of await readdir(join(from, "lib"))) {
		if (/^vector\.(so|dylib)$/.test(file)) copies.push([join(from, "lib", file), libDir]);
	}
	for (const file of await readdir(join(from, "share/extension"))) {
		if (/^vector[.-]/.test(file)) copies.push([join(from, "share/extension", file), extensionDir]);
	}
	if (!copies.some(([file]) => file.endsWith(".control"))) {
		throw new BasepadError(`mise's conda:pgvector@${pgvector} in ${from} has no vector.control.`);
	}
	for (const [file, dir] of copies) {
		// By temp file and rename, so a server loading the library never sees half of it.
		const target = join(dir, file.slice(file.lastIndexOf("/") + 1));
		const temp = `${target}.${process.pid}.tmp`;
		await copyFile(file, temp);
		await rename(temp, target);
	}
	await writeFile(marker, "");
	return pg;
}

/** How a database was copied, fastest first. */
type Route = "file clone" | "template copy" | "dump and restore";

/**
 * Makes `to` a copy of `from`, rows, schema and extensions, while `from`'s clients stay connected,
 * and says how. A copy has no comment, so it carries no owner's stamp. The one way basepad copies a
 * database.
 *
 * A template copy needs `from` to have no other session, and only `allow_connections` keeps out a
 * superuser, so `from` is closed, its sessions ended, and opened again after: a pooled client
 * reconnects by itself. `provision` opens a database an interrupted copy left closed. The copy is a
 * file clone where the server offers one (Postgres 18; copy-on-write on APFS, btrfs, XFS), else a
 * plain template copy; Postgres never falls back by itself, so basepad does. Dump and restore,
 * with `from` open again, only when a template copy fails.
 */
async function copyDatabase(pg: Tool, port: number, from: string, to: string): Promise<Route> {
	const sql = (...statements: string[]) => query(pg, port, statements);
	const offered = await sql(
		"select coalesce(enumvals::text, '') from pg_settings where name = 'file_copy_method'",
	);
	// File by file, not the default WAL_LOG: about 4 times faster on a 1 GB database, and a clone
	// needs it.
	const create = `create database ${identifier(to)} template ${identifier(from)} strategy file_copy`;
	const routes: [Route, string[]][] = [["template copy", [create]]];
	// One session: the setting is the session's own.
	if (offered.includes("clone")) {
		routes.unshift(["file clone", ["set file_copy_method = clone", create]]);
	}
	const failures: string[] = [];
	await sql(`alter database ${identifier(from)} allow_connections false`);
	try {
		await sql(
			`select pg_terminate_backend(pid, 5000) from pg_stat_activity where datname = ${literal(from)} and pid <> pg_backend_pid()`,
		);
		for (const [route, statements] of routes) {
			try {
				await sql(...statements);
				return route;
			} catch (error) {
				failures.push(`${route}: ${(error as Error).message.trim()}`);
				await sql(`drop database if exists ${identifier(to)}`);
			}
		}
	} finally {
		await sql(`alter database ${identifier(from)} allow_connections true`);
	}
	await sql(`create database ${identifier(to)}`);
	const conn = (db: string) =>
		["-h", HOST, "-p", String(port), "-U", USER, "-d", db].map(shellQuote).join(" ");
	try {
		await must(
			"bash",
			[
				"-c",
				`set -o pipefail; ${shellQuote(pg.bin("pg_dump"))} -Fc ${conn(from)} | ${shellQuote(pg.bin("pg_restore"))} --no-owner --exit-on-error ${conn(to)}`,
			],
			{ env: clientEnv() },
		);
	} catch (error) {
		await sql(`drop database if exists ${identifier(to)}`);
		failures.push(`dump and restore: ${(error as Error).message.trim()}`);
		throw new BasepadError(`Could not copy \`${from}\` to \`${to}\`.\n${failures.join("\n")}`);
	}
	return "dump and restore";
}

/** The port of the server running on `data`, read from Postgres's own pid file. */
async function runningPort(data: string): Promise<number | undefined> {
	const text = await readFile(join(data, "postmaster.pid"), "utf8").catch(() => undefined);
	const [pid, , , port] = text?.split("\n") ?? [];
	if (!pid || !port || !alive(Number(pid))) return undefined;
	return Number(port);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Runs SQL in the maintenance database as the superuser, each statement on its own in one session;
 * returns psql's unaligned output.
 */
async function query(pg: Tool, port: number, sql: string | string[]): Promise<string> {
	const out = await must(
		pg.bin("psql"),
		[
			"-h",
			HOST,
			"-p",
			String(port),
			"-U",
			USER,
			"-d",
			"postgres",
			"-tAX",
			"-v",
			"ON_ERROR_STOP=1",
			...[sql].flat().flatMap((statement) => ["-c", statement]),
		],
		{ env: clientEnv() },
	);
	return out.trim();
}

/** `text` for a `like` pattern, its wildcards matched as themselves (backslash escapes). */
function likeEscaped(text: string): string {
	return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The environment for Postgres's client programs, free of the developer's own `PG*` settings. */
function clientEnv(): NodeJS.ProcessEnv {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
	);
	return { ...env, PGCONNECT_TIMEOUT: "2" };
}

function literal(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

function identifier(text: string): string {
	return `"${text.replaceAll('"', '""')}"`;
}
