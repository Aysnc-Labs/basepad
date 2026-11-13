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
		};
	},

	async provision(service, place, { claim, stopped }) {
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
		const exists = (await sql(`select 1 from pg_database where datname = ${literal(db)}`)) === "1";
		if (!exists && place.suffix !== undefined && service.worktree === "copy") {
			await copyDatabase(sql, place.main, db);
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

/**
 * Makes `to` a copy of `from`, rows, schema and extensions. A copy has no comment, so it carries no
 * owner's stamp. The one way basepad copies a database: a template copy, which needs `from` to have
 * no other session.
 */
async function copyDatabase(
	sql: (text: string) => Promise<string>,
	from: string,
	to: string,
): Promise<void> {
	await sql(`create database ${identifier(to)} template ${identifier(from)}`);
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

/** Runs SQL in the maintenance database as the superuser; returns psql's unaligned output. */
async function query(pg: Tool, port: number, sql: string): Promise<string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
	);
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
			"-c",
			sql,
		],
		{ env: { ...env, PGCONNECT_TIMEOUT: "2" } },
	);
	return out.trim();
}

function literal(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

function identifier(text: string): string {
	return `"${text.replaceAll('"', '""')}"`;
}
