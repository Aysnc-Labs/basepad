import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { must, shellQuote, tomlString } from "./exec.ts";
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
	/** The superuser's password. */
	password: string;
	/** Runs SQL in the maintenance database as the superuser, and returns psql's unaligned output. */
	query(sql: string): Promise<string>;
	/** A URL for `database`, as an app connects: `localhost`, which needs no DNS. */
	url(database: string): string;
	/** Creates `database` unless it exists. */
	ensureDatabase(database: string): Promise<void>;
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

	return {
		port,
		password,
		query,
		url: (database) => `postgres://postgres:${password}@localhost:${port}/${database}`,
		async ensureDatabase(database) {
			const found = await query(`select 1 from pg_database where datname = '${database}'`);
			if (found.trim() !== "1") await query(`create database "${database}"`);
		},
	};
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
