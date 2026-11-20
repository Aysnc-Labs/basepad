import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ExtraDaemon, Kind, Place, Snapshot } from "../catalogue.ts";
import { BasepadError, must, shellQuote } from "../internal/exec.ts";
import { writeWhole } from "../internal/files.ts";
import { answers, freePort, waitFor } from "../internal/ports.ts";
import { recordRunning, runningPort } from "../internal/processes.ts";
import { serviceUser } from "../internal/service-user.ts";
import type { Daemon } from "../supervisor.ts";
import { install, type Tool } from "../tools.ts";
import { NEON_PROXY_VERSION, PGVECTOR_VERSIONS } from "../versions.ts";

const HOST = "127.0.0.1";
const USER = "postgres";
const PASSWORD = "basepad";
const READY_MS = 60_000;
const NO_UNIX_SOCKETS = "unix_socket_directories=";
const NEON_PROXY = "neon-proxy";
const ANY_PORT = `${HOST}:0`;

export type PostgresVersion = 17 | 18;

/**
 * What a worktree's database starts as: a copy of main's data, empty, or main's own database
 * (`shared`, which a worktree never drops).
 */
export type PostgresWorktree = "copy" | "empty" | "shared";

type PostgresOptions = { version?: PostgresVersion; worktree?: PostgresWorktree };

interface PostgresServer {
	version: PostgresVersion;
	worktree: PostgresWorktree;
}

function serverWithDefaults(options: PostgresOptions): PostgresServer {
	return { version: options.version ?? 18, worktree: options.worktree ?? "copy" };
}

/** A Postgres server of the project's own, with one database for this service. */
export interface PostgresService extends PostgresServer {
	kind: "postgres";
}

/**
 * A Postgres server of the project's own. `version` is 17 or 18; it defaults to 18. `worktree` is
 * what a worktree's database starts as; it defaults to `copy`.
 */
export function postgres(options: PostgresOptions = {}): PostgresService {
	return { kind: "postgres", ...serverWithDefaults(options) };
}

/** A Postgres server of the project's own with Neon's local proxy in front of it, for `@neondatabase/serverless`. */
export interface PostgresWithNeonProxyService extends PostgresServer {
	kind: "postgresWithNeonProxy";
}

/**
 * A Postgres server of the project's own, as `postgres()` gives, with Neon's local proxy in front
 * of it, so `@neondatabase/serverless` connects as it does to Neon. Its options are `postgres()`'s.
 */
export function postgresWithNeonProxy(options: PostgresOptions = {}): PostgresWithNeonProxyService {
	return { kind: "postgresWithNeonProxy", ...serverWithDefaults(options) };
}

type AnyPostgres = PostgresService | PostgresWithNeonProxyService;

/**
 * What a Postgres service gives to `env`. The `postgres` role's password is real, but local
 * connections are trusted, so a direct connection needs none.
 */
export interface PostgresOutputs {
	url: string;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

/** What a Postgres service with Neon's proxy gives to `env`. */
export interface PostgresWithNeonProxyOutputs extends PostgresOutputs {
	/** What the driver connects with: `postgresql://postgres:basepad@localhost:<port>/<database>?options=endpoint%3Dlocal`. */
	url: string;
	/** Straight to Postgres, for every other tool: Postgres refuses the proxy's `options`. */
	directUrl: string;
	/** The proxy's address for the driver's `wsProxy` setting: `localhost:<port>/v2`. */
	wsProxy: string;
}

export interface PostgresNames {
	database: string;
	main: string;
	data: string;
	snapshots: string;
	snapshot(label: string): string;
	staging(): string;
}

/** Postgres truncates identifiers past this many bytes: https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS */
const IDENTIFIER_MAX = 63;

const schemaOf = <K extends AnyPostgres["kind"]>(kind: K) =>
	z.strictObject({
		kind: z.literal(kind),
		version: z.union([z.literal(17), z.literal(18)], {
			error: "Postgres version must be 17 or 18",
		}),
		worktree: z.enum(["copy", "empty", "shared"], {
			error: "Postgres `worktree` must be copy, empty or shared",
		}),
	});

const server = {
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
		const checkedName = (name: string, what: string, room: string) => {
			const bytes = Buffer.byteLength(name);
			if (bytes > IDENTIFIER_MAX) {
				throw new BasepadError(
					`${what} of \`${key}\` makes the database name "${name}", which is ${bytes} bytes; Postgres allows ${IDENTIFIER_MAX}${room}`,
				);
			}
			return name;
		};
		return {
			database,
			main,
			data: join(dir, "data"),
			snapshots: `${database}@`,
			snapshot: (label) => {
				const room = IDENTIFIER_MAX - Buffer.byteLength(`${database}@`);
				return checkedName(
					`${database}@${label}`,
					`snapshot \`${label}\``,
					`, which leaves ${room > 0 ? `${room} character${room === 1 ? "" : "s"}` : "no room"} for a label here.`,
				);
			},
			staging: () =>
				checkedName(
					`${database}~new`,
					"A replacement",
					". The `db` commands make a database there before it replaces another; shorten `name` or the service key.",
				),
		};
	},

	worktreeData: {
		async list(service, place) {
			const port = await serverPort(place.data);
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
			return all.filter(
				(data) => data.owner === place.owner || (data.owner === "" && data.name === place.database),
			);
		},

		async drop(service, place, names) {
			if (names.includes(place.main)) {
				throw new BasepadError(`\`${place.main}\` is main's database, which basepad never drops.`);
			}
			const port = await serverPort(place.data);
			if (port === undefined || names.length === 0) return;
			const pg = await installPostgres(service.version, place.machine.home);
			for (const name of names) {
				await query(pg, port, `drop database if exists ${identifier(name)} with (force)`);
			}
		},
	},

	async address(_service, place) {
		const port = (await serverPort(place.data)) ?? place.port;
		return `postgresql://${USER}@${HOST}:${port}/${place.database}`;
	},

	database: {
		async save(service, place, label, validated) {
			const name = place.snapshot(label);
			const { pg, port, sql } = await own(service, place);
			await validated();
			const swap = {
				target: name,
				staging: place.staging(),
				owner: place.owner,
				failed: `Could not save snapshot \`${label}\`; any snapshot \`${label}\` there was is kept.`,
			};
			await replace(sql, swap, (staging, owner) =>
				copyDatabase(pg, port, place.database, staging, owner),
			);
		},

		async load(service, place, label, validated) {
			const name = place.snapshot(label);
			const { pg, port, sql } = await own(service, place);
			const found = await snapshotsOf(sql, place);
			const snapshot = found.find((snapshot) => snapshot.label === label);
			if (snapshot === undefined) throw new BasepadError(noSnapshot(place, label, found));
			if (snapshot.invalid) {
				throw new BasepadError(
					`Snapshot \`${label}\` of \`${place.key}\` is invalid, as an interrupted copy or drop leaves a database. \`${place.database}\` is as it was; remove the snapshot with \`basepad db rm ${label}\`.`,
				);
			}
			const swap = {
				target: place.database,
				staging: place.staging(),
				owner: place.owner,
				failed: `Could not load snapshot \`${label}\`; \`${place.database}\` is as it was.`,
			};
			await validated();
			await replace(sql, swap, (staging, owner) => copyDatabase(pg, port, name, staging, owner));
		},

		async snapshots(service, place) {
			const { sql } = await own(service, place);
			return snapshotsOf(sql, place);
		},

		async remove(service, place, label, validated) {
			const name = place.snapshot(label);
			const { sql } = await own(service, place);
			const found = await snapshotsOf(sql, place);
			if (!found.some((snapshot) => snapshot.label === label)) {
				throw new BasepadError(noSnapshot(place, label, found));
			}
			await validated();
			await sql(`drop database ${identifier(name)} with (force)`);
		},

		async import(service, place, source, confirm) {
			const { pg, port, sql } = await own(service, place);
			const from = await sourceOf(source);
			const swap = {
				target: place.database,
				staging: place.staging(),
				owner: place.owner,
				failed: `Could not import ${from.description}; \`${place.database}\` is as it was.`,
			};
			await confirm(place.database);
			await replace(sql, swap, async (staging, owner) => {
				await sql(`create database ${identifier(staging)}`);
				await stampOwner(sql, staging, owner);
				await restore(pg, port, staging, from);
				await rejectEmptySource(pg, port, staging);
			});
			return from.description;
		},

		async export(service, place, file, validated) {
			const { pg, port } = await own(service, place);
			await validated();
			const plain = file !== undefined && /\.sql$/i.test(file);
			const args = [
				...connection(port, place.database),
				...(plain ? ["--format=plain", "--no-owner", "--no-privileges"] : ["--format=custom"]),
			];
			if (file === undefined) {
				await toStdout(pg.bin("pg_dump"), args);
			} else {
				await writeWhole(file, (partial) =>
					must(pg.bin("pg_dump"), [...args, `--file=${partial}`], { env: clientEnv() }),
				);
			}
			return plain ? "plain SQL" : "a custom-format dump";
		},
	},
} satisfies Pick<
	Kind<AnyPostgres, unknown, PostgresNames>,
	"names" | "worktreeData" | "address" | "database"
>;

export const postgresKind: Kind<PostgresService, PostgresOutputs, PostgresNames> = {
	...server,
	schema: schemaOf("postgres"),

	async prepare(service, place) {
		const { daemon } = await prepareServer(service, place);
		return { [place.daemon]: daemon };
	},

	provision(service, place, options) {
		return provisionServer(service, place, options, []);
	},
};

export const postgresWithNeonProxyKind: Kind<
	PostgresWithNeonProxyService,
	PostgresWithNeonProxyOutputs,
	PostgresNames
> = {
	...server,
	schema: schemaOf("postgresWithNeonProxy"),

	extraDaemons: [NEON_PROXY],

	async prepare(service, place) {
		const { port: postgresPort, daemon } = await prepareServer(service, place);
		const proxy = await install(
			"github:aysnc-labs/prebuilt-binaries",
			NEON_PROXY_VERSION,
			place.machine.home,
		);
		const extra = neonProxyOf(place);
		const running = await runningProxy(extra.pid);
		const proxyPort = running?.proxy ?? (await freePort(extra.port));
		const againstOldPostgres = running !== undefined && running.postgres !== postgresPort;
		const argv = [
			proxy.bin("neon-proxy"),
			"--auth-backend=postgres",
			`--auth-endpoint=postgres://${USER}:${PASSWORD}@${HOST}:${postgresPort}/postgres`,
			"--wss",
			`${HOST}:${proxyPort}`,
			// Its other listeners default to fixed ports, so a second project's proxy fails on `Address already in use`:
			// https://github.com/neondatabase/neon/blob/main/proxy/src/binary/proxy.rs
			"--proxy",
			ANY_PORT,
			"--mgmt",
			ANY_PORT,
			"--http",
			ANY_PORT,
		];
		return {
			[place.daemon]: daemon,
			[extra.daemon]: {
				run: `${recordProxy(extra.pid, { proxy: proxyPort, postgres: postgresPort })} && export LOGFMT=text RUST_LOG=warn && exec ${argv.map(shellQuote).join(" ")}`,
				program: argv[0],
				dir: place.dir,
				listens: proxyPort,
				depends: [place.daemon],
				...(againstOldPostgres ? { restart: true as const } : {}),
			},
		};
	},

	async provision(service, place, options) {
		const outputs = await provisionServer(service, place, options, [
			"create schema if not exists neon_control_plane",
			"create table if not exists neon_control_plane.endpoints (endpoint_id text primary key, allowed_ips text)",
		]);
		const proxyPort = await waitFor(
			async () => {
				const port = (await runningProxy(neonProxyOf(place).pid))?.proxy;
				if (port === undefined) throw new Error("It has not started.");
				if (!(await answers(port, [HOST]))) throw new Error(`Nothing answers on port ${port}.`);
				return port;
			},
			`Neon's proxy for \`${place.key}\` didn't answer within ${READY_MS / 1000} s.`,
			READY_MS,
			options.stopped,
		);
		return {
			...outputs,
			url: `postgresql://${USER}:${PASSWORD}@localhost:${outputs.port}/${outputs.database}?options=endpoint%3Dlocal`,
			directUrl: outputs.url,
			wsProxy: `localhost:${proxyPort}/v2`,
		};
	},

	async extraAddress(place) {
		return `ws://localhost:${await neonProxyPort(place)}/v2`;
	},
};

function neonProxyOf(place: Place<PostgresNames>): ExtraDaemon {
	return place.extraDaemons[NEON_PROXY] as ExtraDaemon;
}

async function neonProxyPort(place: Place<PostgresNames>): Promise<number> {
	const extra = neonProxyOf(place);
	return (await runningProxy(extra.pid))?.proxy ?? extra.port;
}

interface ProxyPorts {
	proxy: number;
	postgres: number | undefined;
}

function recordProxy(pid: string, ports: { proxy: number; postgres: number }): string {
	return recordRunning(pid, ports.proxy, ports.postgres);
}

async function runningProxy(pid: string): Promise<ProxyPorts | undefined> {
	const proxy = await runningPort(pid, 1);
	return proxy === undefined ? undefined : { proxy, postgres: await runningPort(pid, 2) };
}

async function prepareServer(
	service: AnyPostgres,
	place: Place<PostgresNames>,
): Promise<{ port: number; daemon: Daemon }> {
	const pg = await installPostgres(service.version, place.machine.home);
	const user = await serviceUser();
	const { data } = place;
	await mkdir(place.dir, { recursive: true });
	await user.grant({ traverse: [pg.dir, place.dir], owned: [place.dir] });
	const initialised = await readFile(join(data, "PG_VERSION"), "utf8").catch(() => undefined);
	if (initialised === undefined) {
		// A half-made folder from an initdb that failed; initdb refuses one that isn't empty:
		// https://www.postgresql.org/docs/current/creating-cluster.html
		await rm(data, { recursive: true, force: true });
		const argv = user.wrap([
			pg.bin("initdb"),
			"-D",
			data,
			"-U",
			USER,
			"--auth=trust",
			// Pinned, or initdb takes the shell's locale and clusters differ between machines:
			// https://www.postgresql.org/docs/current/app-initdb.html
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
	const port = (await serverPort(data)) ?? (await freePort(place.port));
	const server = user.wrap([
		pg.bin("postgres"),
		"-D",
		data,
		"-p",
		String(port),
		"-c",
		`listen_addresses=${HOST}`,
		"-c",
		NO_UNIX_SOCKETS,
	]);
	return {
		port,
		daemon: {
			run: `exec ${server.map(shellQuote).join(" ")}`,
			program: pg.bin("postgres"),
			dir: place.dir,
			// Fast shutdown: SIGTERM's smart shutdown would wait for every app's connections to close:
			// https://www.postgresql.org/docs/current/server-shutdown.html
			stopSignal: "SIGINT",
			listens: port,
		},
	};
}

async function provisionServer(
	service: AnyPostgres,
	place: Place<PostgresNames>,
	{
		claim,
		stopped,
		print,
	}: { claim: boolean; stopped: () => Promise<boolean>; print(line: string): void },
	mainSetup: string[],
): Promise<PostgresOutputs> {
	const pg = await installPostgres(service.version, place.machine.home);
	const { data } = place;
	const port = await waitFor(
		async () => {
			const port = await serverPort(data);
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
	if (place.suffix === undefined) {
		await inOneSession(pg, port, [
			"set password_encryption = 'scram-sha-256'",
			`alter role ${identifier(USER)} password ${literal(PASSWORD)}`,
			...mainSetup,
		]);
	}
	if (place.suffix !== undefined && service.worktree === "shared") return outputs;
	const open = await sql(`select datallowconn from pg_database where datname = ${literal(db)}`);
	const exists = open !== "";
	if (open === "f") await sql(`alter database ${identifier(db)} allow_connections true`);
	if (!exists && place.suffix !== undefined && service.worktree === "copy") {
		const start = performance.now();
		const route = await copyDatabase(pg, port, place.main, db, place.owner);
		const seconds = ((performance.now() - start) / 1000).toFixed(1);
		print(`Copied main's \`${place.key}\` by ${route} in ${seconds} s.`);
	} else if (!exists) {
		await sql(`create database ${identifier(db)}`);
	}
	const owner = await ownerOf(sql, db);
	if (owner !== "" && owner !== place.owner && !claim) {
		throw new BasepadError(
			`The database \`${db}\` belongs to the checkout at ${owner}, which has the same name ("${place.name}"). Two checkouts would share its data, so basepad stops here.\nIf that checkout moved here, or you want this one to take over, run \`basepad up --claim\`.`,
		);
	}
	if (owner !== place.owner) await stampOwnerAndCheck(sql, db, place.owner);
	return outputs;
}

type Source =
	| { format: "custom" | "plain"; file: string; description: string }
	| { format: "url"; url: string; password: string | undefined; description: string };

async function sourceOf(source: string): Promise<Source> {
	if (/^postgres(ql)?:\/\//i.test(source)) {
		let url: URL;
		try {
			url = new URL(source);
		} catch {
			throw new BasepadError(`\`${source}\` is not a URL basepad can read.`);
		}
		const password = url.password === "" ? undefined : decodeURIComponent(url.password);
		url.password = "";
		return {
			format: "url",
			url: url.href,
			password,
			description: `a copy of ${url.host}${url.pathname}`,
		};
	}
	const file = await open(source).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new BasepadError(
				`There is no file ${source}. Import a dump file or a postgres:// URL.`,
			);
		}
		throw error;
	});
	try {
		if ((await file.stat()).isDirectory()) {
			throw new BasepadError(`${source} is a folder. Import a dump file or a postgres:// URL.`);
		}
		const { buffer, bytesRead } = await file.read(Buffer.alloc(5), 0, 5, 0);
		const start = buffer.subarray(0, bytesRead);
		if (start.toString("latin1") === "PGDMP") {
			return { format: "custom", file: source, description: `the custom-format dump ${source}` };
		}
		if (start[0] === 0x1f && start[1] === 0x8b) {
			throw new BasepadError(`${source} is gzipped. Unzip it, then import that.`);
		}
		return { format: "plain", file: source, description: `the SQL file ${source}` };
	} finally {
		await file.close();
	}
}

async function rejectEmptySource(pg: Tool, port: number, name: string): Promise<void> {
	const user = (namespace: string) =>
		`${namespace} not in (select oid from pg_namespace where nspname in ('pg_catalog', 'information_schema', 'pg_toast') or nspname like 'pg\\_%temp\\_%')`;
	const anything = [
		`select 1 from pg_class where ${user("relnamespace")}`,
		`select 1 from pg_proc where ${user("pronamespace")}`,
		`select 1 from pg_type where ${user("typnamespace")}`,
		`select 1 from pg_namespace where ${user("oid")} and nspname <> 'public'`,
		"select 1 from pg_extension where extname <> 'plpgsql'",
	];
	const out = await must(
		pg.bin("psql"),
		[
			...connection(port, name),
			"-tAX",
			"-v",
			"ON_ERROR_STOP=1",
			"-c",
			`select exists (${anything.join(" union all ")})`,
		],
		{ env: clientEnv() },
	);
	if (out.trim() !== "t") throw new BasepadError("It created nothing in the database.");
}

async function restore(pg: Tool, port: number, to: string, from: Source): Promise<void> {
	const into = connection(port, to);
	const restoreAsSuperuser = [
		pg.bin("pg_restore"),
		"--no-owner",
		"--no-privileges",
		"--exit-on-error",
	];
	if (from.format === "url") {
		const env = { ...clientEnv(), ...(from.password ? { PGPASSWORD: from.password } : {}) };
		await must(
			"bash",
			[
				"-c",
				`set -o pipefail; ${shellQuote(pg.bin("pg_dump"))} --format=custom --dbname=${shellQuote(from.url)} | ${[...restoreAsSuperuser, ...into].map(shellQuote).join(" ")}`,
			],
			{ env, label: "pg_dump | pg_restore" },
		);
	} else if (from.format === "plain") {
		try {
			await must(pg.bin("psql"), [...into, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", from.file], {
				env: clientEnv(),
			});
		} catch (error) {
			if (!(error instanceof BasepadError)) throw error;
			throw new BasepadError(
				`${error.message}\nA plain SQL file must load as is: one with other roles' owners or grants needs \`pg_dump --no-owner --no-privileges\`, or use a custom-format dump.`,
			);
		}
	} else {
		await must(
			restoreAsSuperuser[0] as string,
			[...restoreAsSuperuser.slice(1), ...into, from.file],
			{
				env: clientEnv(),
			},
		);
	}
}

function connection(port: number, database: string): string[] {
	return ["-h", HOST, "-p", String(port), "-U", USER, "-d", database];
}

function toStdout(file: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { env: clientEnv(), stdio: ["ignore", "inherit", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new BasepadError(`\`${file}\` failed (exit ${code}):\n${stderr.trim()}`)),
		);
	});
}

async function own(
	service: AnyPostgres,
	place: Place<PostgresNames>,
): Promise<{ pg: Tool; port: number; sql: Sql }> {
	if (place.suffix !== undefined && service.worktree === "shared") {
		throw new BasepadError(
			`\`${place.key}\` is shared with main in worktrees (\`worktree: "shared"\`), so its database is main's. Run this in main to act on it.`,
		);
	}
	const port = await serverPort(place.data);
	if (port === undefined) throw new BasepadError(`Postgres for \`${place.key}\` is not running.`);
	const pg = await installPostgres(service.version, place.machine.home);
	return { pg, port, sql: (text) => query(pg, port, text) };
}

async function snapshotsOf(sql: Sql, place: Place<PostgresNames>): Promise<Snapshot[]> {
	const prefix = place.snapshots;
	const rows = await sql(
		// `datconnlimit` -2 marks an invalid database: https://www.postgresql.org/docs/current/catalog-pg-database.html
		`select datname || '|' || pg_database_size(oid) || '|' || (datconnlimit = -2) from pg_database where datname like ${literal(`${likeEscaped(prefix)}%`)} order by datname`,
	);
	return rows
		.split("\n")
		.filter(Boolean)
		.map((row) => {
			const [invalid, bytes, ...name] = row.split("|").reverse();
			return {
				label: name.reverse().join("|").slice(prefix.length),
				database: place.database,
				bytes: Number(bytes),
				...(invalid === "true" ? { invalid: true as const } : {}),
			};
		});
}

function noSnapshot(
	place: Place<PostgresNames>,
	label: string,
	found: { label: string }[],
): string {
	const labels = found.map((snapshot) => `\`${snapshot.label}\``).join(", ");
	return `\`${place.key}\` has no snapshot \`${label}\`. ${found.length === 0 ? "It has none; make one with `basepad db save`." : `Its snapshots: ${labels}.`}`;
}

async function replace(
	sql: Sql,
	{
		target,
		staging,
		owner,
		failed,
	}: { target: string; staging: string; owner: string; failed: string },
	fill: (staging: string, owner: string) => Promise<unknown>,
): Promise<void> {
	const dropStaging = () => sql(`drop database if exists ${identifier(staging)} with (force)`);
	await dropStaging();
	try {
		await fill(staging, owner);
	} catch (error) {
		await dropStaging().catch(() => {});
		if (!(error instanceof BasepadError)) throw error;
		throw new BasepadError(`${failed}\n${error.message}`);
	}
	await stampOwner(sql, staging, owner);
	await sql(`drop database if exists ${identifier(target)} with (force)`);
	await sql(`alter database ${identifier(staging)} rename to ${identifier(target)}`);
}

async function stampOwner(sql: Sql, name: string, owner: string): Promise<void> {
	await sql(`comment on database ${identifier(name)} is ${literal(owner)}`);
}

function ownerOf(sql: Sql, name: string): Promise<string> {
	return sql(
		`select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = ${literal(name)}`,
	);
}

/** A comment on a database that has gone is only a warning, so the owner is read back: https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/comment.c#L46-L62 */
export async function stampOwnerAndCheck(sql: Sql, name: string, owner: string): Promise<void> {
	await stampOwner(sql, name, owner);
	if ((await ownerOf(sql, name)) !== owner) {
		throw new BasepadError(`Could not mark \`${name}\` as belonging to ${owner}.`);
	}
}

async function installPostgres(version: PostgresVersion, home: string): Promise<Tool> {
	const pg = await install("postgres", String(version), home);
	const pgvector = PGVECTOR_VERSIONS[version];
	const placed = join(pg.dir, `.basepad-pgvector-${pgvector}`);
	if (!existsSync(placed)) {
		await placePgvector(pg, pgvector, home);
		await writeFile(placed, "");
	}
	return pg;
}

async function placePgvector(pg: Tool, version: string, home: string): Promise<void> {
	const from = (await install("conda:pgvector", version, home)).dir;
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
		throw new BasepadError(`mise's conda:pgvector@${version} in ${from} has no vector.control.`);
	}
	for (const [file, dir] of copies) {
		const target = join(dir, file.slice(file.lastIndexOf("/") + 1));
		await writeWhole(target, (partial) => copyFile(file, partial));
	}
}

type Sql = (text: string) => Promise<string>;

type Route = "file clone" | "template copy" | "dump and restore";

async function copyDatabase(
	pg: Tool,
	port: number,
	from: string,
	to: string,
	owner: string,
): Promise<Route> {
	const sql = (text: string) => query(pg, port, text);
	const failures: string[] = [];
	const copied = await withSourceClosed(sql, from, async () => {
		for (const [route, statements] of await templateRoutes(sql, from, to)) {
			try {
				await inOneSession(pg, port, statements);
			} catch (error) {
				failures.push(`${route}: ${(error as Error).message.trim()}`);
				await sql(`drop database if exists ${identifier(to)}`);
				continue;
			}
			return route;
		}
		return undefined;
	});
	if (copied !== undefined) {
		await stampOwner(sql, to, owner);
		return copied;
	}
	await sql(`create database ${identifier(to)}`);
	await stampOwner(sql, to, owner);
	try {
		await dumpAndRestore(pg, port, from, to);
	} catch (error) {
		await sql(`drop database if exists ${identifier(to)}`);
		failures.push(`dump and restore: ${(error as Error).message.trim()}`);
		throw new BasepadError(`Could not copy \`${from}\` to \`${to}\`.\n${failures.join("\n")}`);
	}
	return "dump and restore";
}

async function templateRoutes(sql: Sql, from: string, to: string): Promise<[Route, string[]][]> {
	const offered = await sql(
		"select coalesce(enumvals::text, '') from pg_settings where name = 'file_copy_method'",
	);
	// File by file, not the default WAL_LOG: faster on a large database, and a clone needs it:
	// https://www.postgresql.org/docs/current/sql-createdatabase.html#CREATE-DATABASE-STRATEGY
	const create = `create database ${identifier(to)} template ${identifier(from)} strategy file_copy`;
	const templateCopy: [Route, string[]] = ["template copy", [create]];
	if (!offered.includes("clone")) return [templateCopy];
	return [["file clone", ["set file_copy_method = clone", create]], templateCopy];
}

async function withSourceClosed<T>(sql: Sql, database: string, copy: () => Promise<T>): Promise<T> {
	await sql(`alter database ${identifier(database)} allow_connections false`);
	try {
		await sql(
			`select pg_terminate_backend(pid, 5000) from pg_stat_activity where datname = ${literal(database)} and pid <> pg_backend_pid()`,
		);
		return await copy();
	} finally {
		await sql(`alter database ${identifier(database)} allow_connections true`);
	}
}

async function dumpAndRestore(pg: Tool, port: number, from: string, to: string): Promise<void> {
	const conn = (db: string) => connection(port, db).map(shellQuote).join(" ");
	await must(
		"bash",
		[
			"-c",
			`set -o pipefail; ${shellQuote(pg.bin("pg_dump"))} -Fc ${conn(from)} | ${shellQuote(pg.bin("pg_restore"))} --no-owner --exit-on-error ${conn(to)}`,
		],
		{ env: clientEnv() },
	);
}

function serverPort(data: string): Promise<number | undefined> {
	return runningPort(join(data, "postmaster.pid"), 3);
}

function query(pg: Tool, port: number, sql: string): Promise<string> {
	return inOneSession(pg, port, [sql]);
}

async function inOneSession(pg: Tool, port: number, statements: string[]): Promise<string> {
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
			...statements.flatMap((statement) => ["-c", statement]),
		],
		{ env: clientEnv() },
	);
	return out.trim();
}

function likeEscaped(text: string): string {
	return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

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
