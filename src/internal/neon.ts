import { Socket } from "node:net";
import { join } from "node:path";
import { shellQuote, tomlString } from "./exec.ts";
import { HOME_NAMESPACE, type Home } from "./home.ts";
import { mise } from "./mise.ts";
import { freePort, waitFor } from "./ports.ts";
import type { PostgresServer } from "./postgres.ts";
import { NEON_PROXY_TOOL, NEON_PROXY_VERSION, PITCHFORK_VERSION } from "./versions.ts";

/** The shared Neon proxy's daemon name in the home project. */
export const NEON_PROXY_DAEMON = "neon-proxy";
export const NEON_PROXY_DAEMON_ID = `${HOME_NAMESPACE}/${NEON_PROXY_DAEMON}`;

/** Just above the shared Postgres's range, and clear of the proxy's defaults (4432, 7000, 7001). */
const PORT_BASE = 54330;

/**
 * Without TLS there's no SNI to name a Neon endpoint, so the proxy needs one in the connection's
 * options. Any ID works; there is one local endpoint.
 */
export const NEON_ENDPOINT_OPTIONS = "options=endpoint%3Dlocal";

export interface NeonProxy {
	/** What Neon's driver takes as `neonConfig.wsProxy`: the WebSocket listener's host, port and path. */
	wsProxy: string;
	/** A URL for `database` that Neon's driver accepts through this proxy. */
	url(database: string): string;
}

/**
 * Brings up the shared Neon proxy in the home project, in front of the shared Postgres. It serves
 * every database on the server over plain WebSocket, so it needs no certificate. It logs in to the
 * maintenance database as the superuser to look up roles, never to an app's database.
 */
export async function startNeonProxy(home: Home, postgres: PostgresServer): Promise<NeonProxy> {
	if (!home.records.neonProxy) {
		const wss = await freePort(PORT_BASE, home.records);
		const proxy = await freePort(wss + 1, home.records);
		const mgmt = await freePort(proxy + 1, home.records);
		const http = await freePort(mgmt + 1, home.records);
		home.records.neonProxy = { wss, proxy, mgmt, http };
		await home.save();
	}
	const ports = home.records.neonProxy;

	// The proxy's stand-in control plane reads allow-lists from this table, but doesn't create it.
	// It stays empty: no row means no allow-list.
	await postgres.query(
		"create schema if not exists neon_control_plane; create table if not exists neon_control_plane.endpoints(endpoint_id text primary key, allowed_ips text)",
	);

	const tool = `${NEON_PROXY_TOOL}@${NEON_PROXY_VERSION}`;
	await mise(home.dir, "install", "--quiet", tool, `pitchfork@${PITCHFORK_VERSION}`);
	const bin = join((await mise(home.dir, "where", tool)).trim(), "neon-proxy");
	const argv = [
		"env",
		"LOGFMT=text",
		bin,
		"--auth-backend=postgres",
		`--auth-endpoint=postgres://postgres:${postgres.password}@127.0.0.1:${postgres.port}/postgres`,
		// No --tls-key or --tls-cert: the WebSocket listener serves plain ws://.
		"--wss",
		`127.0.0.1:${ports.wss}`,
		// Its other listeners default to fixed ports, so they're set too.
		"--proxy",
		`127.0.0.1:${ports.proxy}`,
		"--mgmt",
		`127.0.0.1:${ports.mgmt}`,
		"--http",
		`127.0.0.1:${ports.http}`,
	];
	await home.configure(NEON_PROXY_DAEMON, {
		tools: { [NEON_PROXY_TOOL]: NEON_PROXY_VERSION },
		table: [
			`[daemons.${NEON_PROXY_DAEMON}]`,
			`run = ${tomlString(`exec ${argv.map(shellQuote).join(" ")}`)}`,
			`port = ${ports.wss}`,
			`ready_port = ${ports.wss}`,
			"proxy = false",
		].join("\n"),
	});
	await mise(home.dir, "daemons", "start", NEON_PROXY_DAEMON);
	await waitFor(
		() => connect(ports.wss),
		`Neon's proxy didn't start listening. For its log, run \`mise daemons logs ${NEON_PROXY_DAEMON}\` in ${home.dir}.`,
	);

	return {
		wsProxy: `localhost:${ports.wss}/v2`,
		// The proxy rejects IP hosts, so it's `localhost`, which needs no DNS.
		url: (database) => `${postgres.url(database)}?${NEON_ENDPOINT_OPTIONS}`,
	};
}

function connect(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new Socket();
		socket.once("error", reject);
		socket.connect(port, "127.0.0.1", () => {
			socket.destroy();
			resolve();
		});
	});
}
