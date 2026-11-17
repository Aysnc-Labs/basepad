import { createConnection, createServer } from "node:net";
import { BasepadError } from "./exec.ts";

const SPAN = 100;

export async function freePort(from: number): Promise<number> {
	for (let port = from; port < from + SPAN && port <= 65535; port++) {
		if (!(await answers(port)) && (await canListen(port))) return port;
	}
	throw new BasepadError(`No free port on 127.0.0.1 from ${from} to ${from + SPAN - 1}.`);
}

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

export class Stopped extends Error {}

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
