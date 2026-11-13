import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	copyFile,
	type FileHandle,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Kind, Place, Snapshot } from "../catalogue.ts";
import { BasepadError, exec, must, shellQuote } from "../internal/exec.ts";
import { freePort, waitFor } from "../internal/ports.ts";
import { runningPort } from "../internal/processes.ts";
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
	/** What every snapshot's database name starts with: `<database>@`. Unchecked: it names none. */
	snapshots: string;
	/**
	 * Snapshot `label`'s database: `<database>@<label>`. No database basepad names has `@`, so a
	 * snapshot is never taken for one, and main's (`<main>@…`) are never among its worktrees' data
	 * (`<main>_<suffix>…`), while a worktree's are, stamped with its folder like its database.
	 * Throws a `BasepadError`, with the room left for a label, when the name is past Postgres's limit.
	 */
	snapshot(label: string): string;
	/**
	 * Where the `db` commands make a database before it replaces the environment's or one of its
	 * snapshots: `<database>~new`, never a snapshot (`@`) or a worktree's (`_`). Throws a
	 * `BasepadError` when the name is past Postgres's limit.
	 */
	staging(): string;
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
		// Checked when used, not here: a label is the command's input, and a database that fits
		// stays usable even when it leaves no room for these.
		const named = (name: string, what: string, room: string) => {
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
				return named(
					`${database}@${label}`,
					`snapshot \`${label}\``,
					`, which leaves ${room > 0 ? `${room} characters` : "no room"} for a label here.`,
				);
			},
			staging: () =>
				named(
					`${database}~new`,
					"A replacement",
					". The `db` commands make a database there before it replaces another; shorten `name` or the service key.",
				),
		};
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
		const port = (await serverPort(data)) ?? (await freePort(place.port));
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
		// A shared worktree database is main's, which main provisions and stamps.
		if (place.suffix !== undefined && service.worktree === "shared") return outputs;
		const open = await sql(`select datallowconn from pg_database where datname = ${literal(db)}`);
		const exists = open !== "";
		// Left closed by a copy that was interrupted.
		if (open === "f") await sql(`alter database ${identifier(db)} allow_connections true`);
		if (!exists && place.suffix !== undefined && service.worktree === "copy") {
			const start = performance.now();
			const route = await copyDatabase(pg, port, place.main, db, place.owner);
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
			// By name only while unstamped: one stamped elsewhere is another checkout's worktree's.
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
				// A worktree's app may still hold it open; its sessions end with it.
				await query(pg, port, `drop database if exists ${identifier(name)} with (force)`);
			}
		},
	},

	async address(_service, place) {
		const port = (await serverPort(place.data)) ?? place.port;
		return `postgresql://${USER}@${HOST}:${port}/${place.database}`;
	},

	database: {
		async save(service, place, label) {
			const name = place.snapshot(label);
			const { pg, port, sql } = await own(service, place);
			// A label names one snapshot: one there is replaced, and kept should the copy fail.
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

		async load(service, place, label) {
			const name = place.snapshot(label);
			const { pg, port, sql } = await own(service, place);
			const found = await snapshotsOf(sql, place);
			if (!found.some((snapshot) => snapshot.label === label)) {
				throw new BasepadError(noSnapshot(place, label, found));
			}
			const swap = {
				target: place.database,
				staging: place.staging(),
				owner: place.owner,
				failed: `Could not load snapshot \`${label}\`; \`${place.database}\` is as it was.`,
			};
			await replace(sql, swap, (staging, owner) => copyDatabase(pg, port, name, staging, owner));
		},

		async snapshots(service, place) {
			const { sql } = await own(service, place);
			return snapshotsOf(sql, place);
		},

		async remove(service, place, label) {
			const name = place.snapshot(label);
			const { sql } = await own(service, place);
			const found = await snapshotsOf(sql, place);
			if (!found.some((snapshot) => snapshot.label === label)) {
				throw new BasepadError(noSnapshot(place, label, found));
			}
			await sql(`drop database ${identifier(name)} with (force)`);
		},

		async import(service, place, source, confirm) {
			const { pg, port, sql } = await own(service, place);
			const from = await sourceOf(source);
			// Named before asking, so a name past the limit is refused first.
			const swap = {
				target: place.database,
				staging: place.staging(),
				owner: place.owner,
				failed: `Could not import ${from.description}; \`${place.database}\` is as it was.`,
			};
			await confirm(place.database);
			await replace(sql, swap, async (staging, owner) => {
				await sql(`create database ${identifier(staging)}`);
				await stamp(sql, staging, owner);
				await restore(pg, port, staging, from);
			});
			return from.description;
		},

		async export(service, place, file) {
			const { pg, port } = await own(service, place);
			const plain = file !== undefined && /\.sql$/i.test(file);
			const args = [
				...connection(port, place.database),
				...(plain ? ["--format=plain", "--no-owner", "--no-privileges"] : ["--format=custom"]),
			];
			if (file === undefined) {
				await toStdout(pg.bin("pg_dump"), args);
			} else {
				// Written beside and renamed, so a failed export never leaves half a dump at `file`.
				const partial = `${file}.partial`;
				try {
					await must(pg.bin("pg_dump"), [...args, `--file=${partial}`], { env: clientEnv() });
				} catch (error) {
					await rm(partial, { force: true });
					throw error;
				}
				await rename(partial, file);
			}
			return plain ? "plain SQL" : "a custom-format dump";
		},
	},
};

/** A source `db import` reads: a dump file in either format, or another server's database. */
type Source =
	| { format: "custom" | "plain"; file: string; description: string }
	| { format: "url"; url: string; password: string | undefined; description: string };

/**
 * What `source` is: a `postgres://` URL, else a file, a custom-format dump when it starts with
 * `PGDMP`, else plain SQL. A URL's password is kept apart, out of argv and messages.
 */
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
		if (!(await hasContent(file))) {
			throw new BasepadError(
				`${source} is empty, so nothing changed. Import a dump file or a postgres:// URL.`,
			);
		}
		return { format: "plain", file: source, description: `the SQL file ${source}` };
	} finally {
		await file.close();
	}
}

/** Whether `file` holds anything but whitespace, read only as far as its first other byte. */
async function hasContent(file: FileHandle): Promise<boolean> {
	const chunk = Buffer.alloc(64 * 1024);
	for (let at = 0; ; ) {
		const { bytesRead } = await file.read(chunk, 0, chunk.length, at);
		if (bytesRead === 0) return false;
		if (/\S/.test(chunk.toString("latin1", 0, bytesRead))) return true;
		at += bytesRead;
	}
}

/** Loads `from` into the empty database `to`, stopping at the first error. */
async function restore(pg: Tool, port: number, to: string, from: Source): Promise<void> {
	const into = connection(port, to);
	// Owners and grants name roles this server lacks; everything here belongs to its superuser.
	const pgRestore = [pg.bin("pg_restore"), "--no-owner", "--no-privileges", "--exit-on-error"];
	if (from.format === "url") {
		const env = { ...clientEnv(), ...(from.password ? { PGPASSWORD: from.password } : {}) };
		// Not `must`: its message repeats the command, and the URL is the user's to show.
		const out = await exec(
			"bash",
			[
				"-c",
				`set -o pipefail; ${shellQuote(pg.bin("pg_dump"))} --format=custom --dbname=${shellQuote(from.url)} | ${[...pgRestore, ...into].map(shellQuote).join(" ")}`,
			],
			{ env },
		);
		if (out.code !== 0) throw new BasepadError((out.stderr || out.stdout).trim());
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
		await must(pgRestore[0] as string, [...pgRestore.slice(1), ...into, from.file], {
			env: clientEnv(),
		});
	}
}

/** Client arguments for database `database` on the server at `port`. */
function connection(port: number, database: string): string[] {
	return ["-h", HOST, "-p", String(port), "-U", USER, "-d", database];
}

/** Runs a program with its standard output as basepad's own, for a dump piped elsewhere. */
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

/**
 * The running server's SQL, for a service whose database is the environment's own. A worktree's
 * `shared` service's is main's, which the worktree's commands never touch.
 */
async function own(
	service: PostgresService,
	place: Place<PostgresNames>,
): Promise<{ pg: Tool; port: number; sql: (text: string) => Promise<string> }> {
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

/** The environment's snapshots, found by name. */
async function snapshotsOf(
	sql: (text: string) => Promise<string>,
	place: Place<PostgresNames>,
): Promise<Snapshot[]> {
	const prefix = place.snapshots;
	const rows = await sql(
		`select datname || '|' || pg_database_size(oid) from pg_database where datname like ${literal(`${likeEscaped(prefix)}%`)} order by datname`,
	);
	return rows
		.split("\n")
		.filter(Boolean)
		.map((row) => {
			const at = row.lastIndexOf("|");
			return {
				label: row.slice(prefix.length, at),
				database: place.database,
				bytes: Number(row.slice(at + 1)),
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

/**
 * Replaces database `target` with one `fill` makes at `staging`, beside it: the one way the `db`
 * commands replace a database. `fill` makes `staging` and stamps it with `owner` as soon as it
 * exists, so one an interrupted run leaves is found as that checkout's, and goes with its worktree;
 * once `fill` has finished, `replace` stamps it again whatever `fill` did. Only then is `target`
 * dropped, its sessions ended (`with (force)` keeps new ones out until it is gone), and the new one
 * renamed to it, open, its stamp with it. A `fill` that fails leaves `target` as it was, and
 * nothing beside it, and throws `failed` with its reason. Clients connect again by themselves, to
 * the new one.
 */
async function replace(
	sql: (text: string) => Promise<string>,
	{
		target,
		staging,
		owner,
		failed,
	}: { target: string; staging: string; owner: string; failed: string },
	fill: (staging: string, owner: string) => Promise<unknown>,
): Promise<void> {
	const dropStaging = () => sql(`drop database if exists ${identifier(staging)} with (force)`);
	// Left by a replacement that was interrupted.
	await dropStaging();
	try {
		await fill(staging, owner);
	} catch (error) {
		// Its cause is what the developer needs; one left is dropped by the next replacement.
		await dropStaging().catch(() => {});
		if (!(error instanceof BasepadError)) throw error;
		throw new BasepadError(`${failed}\n${error.message}`);
	}
	await stamp(sql, staging, owner);
	await sql(`drop database if exists ${identifier(target)} with (force)`);
	await sql(`alter database ${identifier(staging)} rename to ${identifier(target)}`);
}

/** Marks database `name` as belonging to the checkout at `owner`, as `provision` does. */
async function stamp(
	sql: (text: string) => Promise<string>,
	name: string,
	owner: string,
): Promise<void> {
	await sql(`comment on database ${identifier(name)} is ${literal(owner)}`);
}

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
 * and says how. `to` is stamped as belonging to the checkout at `owner` as soon as it exists, so a
 * copy an interrupted run leaves is found as that checkout's. The one way basepad copies a database.
 *
 * A template copy needs `from` to have no other session, and only `allow_connections` keeps out a
 * superuser, so `from` is closed, its sessions ended, and opened again after: a pooled client
 * reconnects by itself. `provision` opens a database an interrupted copy left closed. The copy is a
 * file clone where the server offers one (Postgres 18; copy-on-write on APFS, btrfs, XFS), else a
 * plain template copy; Postgres never falls back by itself, so basepad does. Dump and restore,
 * with `from` open again, only when a template copy fails.
 */
async function copyDatabase(
	pg: Tool,
	port: number,
	from: string,
	to: string,
	owner: string,
): Promise<Route> {
	const sql = (...statements: string[]) => query(pg, port, statements);
	const offered = await sql(
		"select coalesce(enumvals::text, '') from pg_settings where name = 'file_copy_method'",
	);
	// File by file, not the default WAL_LOG: faster on a large database, and a clone needs it.
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
			} catch (error) {
				failures.push(`${route}: ${(error as Error).message.trim()}`);
				await sql(`drop database if exists ${identifier(to)}`);
				continue;
			}
			await stamp(sql, to, owner);
			return route;
		}
	} finally {
		await sql(`alter database ${identifier(from)} allow_connections true`);
	}
	await sql(`create database ${identifier(to)}`);
	await stamp(sql, to, owner);
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

/** The port of the server running on `data`, from Postgres's own pid file. */
function serverPort(data: string): Promise<number | undefined> {
	return runningPort(join(data, "postmaster.pid"), 3);
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
