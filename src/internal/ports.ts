import { createConnection, createServer } from "node:net";
import { BasepadError } from "./exec.ts";

/** How many ports past the first one `freePort` tries. */
const SPAN = 100;

/** The first port from `from` on loopback that nothing listens on and basepad can bind. */
export async function freePort(from: number): Promise<number> {
	for (let port = from; port < from + SPAN && port <= 65535; port++) {
		if (!(await answers(port)) && (await canListen(port))) return port;
	}
	throw new BasepadError(`No free port on 127.0.0.1 from ${from} to ${from + SPAN - 1}.`);
}

/** Whether something accepts connections on `port` at any of `hosts`, tried in order. */
export async function answers(
	port: number,
	hosts: readonly string[] = ["127.0.0.1"],
): Promise<boolean> {
	for (const host of hosts) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ host, port });
			socket.setTimeout(500);
			socket.on("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.on("timeout", () => {
				socket.destroy();
				resolve(false);
			});
			socket.on("error", () => resolve(false));
		});
		if (ok) return true;
	}
	return false;
}

function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
			server.close(() => resolve(true)),
		);
	});
}

/** What `waitFor` throws when what it waits on has stopped: waiting longer cannot help. */
export class Stopped extends Error {}

/**
 * Polls `check` until it resolves, or throws `failure` with the last error after `timeoutMs`.
 * After each failed check it asks `stopped`, and throws `Stopped` at once when it says so.
 */
export async function waitFor<T>(
	check: () => Promise<T>,
	failure: string,
	timeoutMs: number,
	stopped: () => Promise<boolean> = async () => false,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await check();
		} catch (error) {
			if (await stopped()) throw new Stopped(failure);
			if (Date.now() > deadline) {
				throw new BasepadError(`${failure}\n${(error as Error).message}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}
