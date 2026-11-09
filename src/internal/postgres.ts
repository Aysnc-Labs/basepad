import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BasepadError, must, shellQuote, tomlString } from "./exec.ts";
import { HOME_NAMESPACE, type Home } from "./home.ts";
import { mise } from "./mise.ts";
import { freePort, waitFor } from "./ports.ts";
import { serviceUser } from "./service-user.ts";
import { PITCHFORK_VERSION, POSTGRES_VERSION } from "./versions.ts";

/** The shared Postgres's daemon name in the home project. */
export const POSTGRES_DAEMON = "postgres";
export const POSTGRES_DAEMON_ID = `${HOME_NAMESPACE}/${POSTGRES_DAEMON}`;

/** Clear of Postgres's default 5432, so a Postgres the user already runs keeps its port. */
const PORT_BASE = 54320;

export interface PostgresServer {
	port: number;
	/** A URL for `database`, as an app connects: `localhost`, which needs no DNS. */
	url(database: string): string;
	/** Creates `database` unless it exists. */
	ensureDatabase(database: string): Promise<void>;
	hasDatabase(database: string): Promise<boolean>;
	/**
	 * Creates `to` as a copy of `from`, without disturbing anyone connected to `from`: a template
	 * copy when nothing is, else a dump and restore. Says which it did.
	 */
	copyDatabase(from: string, to: string): Promise<"template" | "dump">;
	/** Drops `database` if it exists, closing its connections. */
	dropDatabase(database: string): Promise<void>;
}

/**
 * Brings up the shared Postgres in the home project: installs it, initialises its cluster once,
 * starts its daemon and waits until it accepts queries. Safe to call when it is already running.
 */
export async function startPostgres(home: Home): Promise<PostgresServer> {
	if (!home.records.postgres) {
		home.records.postgres = {
			port: await freePort(PORT_BASE, home.records),
			password: randomBytes(18).toString("base64url"),
		};
		await home.save();
	}
	const { port, password } = home.records.postgres;
	const state = join(home.dir, "postgres");
	const data = join(state, "data");
	const socket = join(state, "run");

	await mkdir(home.dir, { recursive: true });
	await mise(
		home.dir,
		"install",
		"--quiet",
		`postgres@${POSTGRES_VERSION}`,
		`pitchfork@${PITCHFORK_VERSION}`,
	);
	const bin = join((await mise(home.dir, "where", `postgres@${POSTGRES_VERSION}`)).trim(), "bin");
	const user = await serviceUser();

	await mkdir(socket, { recursive: true });
	await user.grant({ traverse: [bin, state], owned: [state, socket] });
	if (!(await exists(join(data, "PG_VERSION"))))
		await initCluster(bin, state, data, password, user.wrap);

	const server = user.wrap([
		join(bin, "postgres"),
		"-D",
		data,
		"-p",
		String(port),
		"-k",
		socket,
		"-c",
		"listen_addresses=127.0.0.1",
	]);
	await home.configure(POSTGRES_DAEMON, {
		tools: { postgres: POSTGRES_VERSION },
		table: [
			`[daemons.${POSTGRES_DAEMON}]`,
			`run = ${tomlString(`exec ${server.map(shellQuote).join(" ")}`)}`,
			`port = ${port}`,
			`ready_port = ${port}`,
			// basepad writes every variable itself; mise's own <NAME>_URL would point at an HTTP proxy.
			"proxy = false",
		].join("\n"),
	});
	await mise(home.dir, "daemons", "start", POSTGRES_DAEMON);

	const query = async (sql: string): Promise<string> =>
		must(
			join(bin, "psql"),
			[
				"-h",
				"127.0.0.1",
				"-p",
				String(port),
				"-U",
				"postgres",
				"-d",
				"postgres",
				"-tAX",
				"-v",
				"ON_ERROR_STOP=1",
				"-c",
				sql,
			],
			{
				env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "2" },
			},
		);
	// pitchfork can report a daemon running before it is ready, so basepad checks for itself.
	await waitFor(
		() => query("select 1"),
		`Postgres didn't become ready. For its log, run \`mise daemons logs ${POSTGRES_DAEMON}\` in ${home.dir}.`,
	);

	const hasDatabase = async (database: string): Promise<boolean> =>
		(await query(`select 1 from pg_database where datname = '${database}'`)).trim() === "1";
	return {
		port,
		hasDatabase,
		url: (database) => `postgres://postgres:${password}@localhost:${port}/${database}`,
		async ensureDatabase(database) {
			if (!(await hasDatabase(database))) await query(`create database "${database}"`);
		},
		async copyDatabase(from, to) {
			// Postgres refuses a template that anyone is connected to, after waiting 5 s for them to
			// leave, so basepad asks first; closing their connections would interrupt main.
			const busy = await query(`select count(*) from pg_stat_activity where datname = '${from}'`);
			if (busy.trim() === "0") {
				try {
					await query(`create database "${to}" template "${from}"`);
					return "template";
				} catch (error) {
					if (!/being accessed by other users/.test((error as Error).message)) throw error;
				}
			}
			await query(`create database "${to}"`);
			try {
				await dumpAndRestore(bin, port, password, from, to);
			} catch (error) {
				await query(`drop database if exists "${to}" with (force)`);
				throw error;
			}
			return "dump";
		},
		async dropDatabase(database) {
			await query(`drop database if exists "${database}" with (force)`);
		},
	};
}

/** `pg_dump | pg_restore`, as the superuser: what copies a database that is in use. */
async function dumpAndRestore(
	bin: string,
	port: number,
	password: string,
	from: string,
	to: string,
): Promise<void> {
	const env = { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" };
	const conn = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"];
	const dump = spawn(join(bin, "pg_dump"), [...conn, "-Fc", "-d", from], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const restore = spawn(
		join(bin, "pg_restore"),
		[...conn, "--no-owner", "--exit-on-error", "-d", to],
		{ env, stdio: ["pipe", "ignore", "pipe"] },
	);
	dump.stdout.pipe(restore.stdin);
	const finished = (child: ChildProcess, name: string) =>
		new Promise<void>((resolve, reject) => {
			let stderr = "";
			child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) =>
				code === 0
					? resolve()
					: reject(new BasepadError(`${name} ${from} failed (exit ${code}):\n${stderr.trim()}`)),
			);
		});
	await Promise.all([finished(dump, "pg_dump"), finished(restore, "pg_restore")]);
}

async function initCluster(
	bin: string,
	state: string,
	data: string,
	password: string,
	wrap: (argv: readonly string[]) => string[],
): Promise<void> {
	const pwfile = join(state, "initdb.pw");
	await writeFile(pwfile, password, { mode: 0o644 });
	try {
		const argv = wrap([
			join(bin, "initdb"),
			"-D",
			data,
			"-U",
			"postgres",
			"--auth=scram-sha-256",
			`--pwfile=${pwfile}`,
			// Pinned, or initdb takes the shell's locale and clusters differ between machines.
			"--encoding=UTF8",
			"--locale-provider=builtin",
			"--locale=C.UTF-8",
		]);
		await must(argv[0] as string, argv.slice(1));
	} finally {
		await rm(pwfile, { force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
