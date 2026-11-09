import { createServer } from "node:net";
import { BasepadError } from "./exec.ts";
import type { Records } from "./records.ts";

/**
 * The first port from `from` that nothing listens on and no basepad record holds, so a service
 * that is stopped right now never loses its port to another.
 */
export async function freePort(from: number, records: Records): Promise<number> {
	const taken = recordedPorts(records);
	for (let port = from; port < from + 1000; port++) {
		if (!taken.has(port) && (await canListen(port))) return port;
	}
	throw new BasepadError(`No free port from ${from} to ${from + 999}.`);
}

function recordedPorts(records: Records): Set<number> {
	const ports = new Set<number>();
	if (records.postgres) ports.add(records.postgres.port);
	if (records.mailpit) ports.add(records.mailpit.smtpPort).add(records.mailpit.uiPort);
	for (const project of Object.values(records.projects)) {
		if (project.app) ports.add(project.app.port);
		for (const service of Object.values(project.services)) {
			if (service.type === "redis") ports.add(service.port);
		}
	}
	return ports;
}

export function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

/** Polls `check` until it resolves, or throws `failure` with the last error after `timeoutMs`. */
export async function waitFor(
	check: () => Promise<unknown>,
	failure: string,
	timeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await check();
			return;
		} catch (error) {
			if (Date.now() > deadline) {
				throw new BasepadError(`${failure}\n${(error as Error).message}`);
			}
			await new Promise((r) => setTimeout(r, 250));
		}
	}
}
