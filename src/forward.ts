import { existsSync } from "node:fs";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * The forwarder: makes port 443 reach basepad's proxy on macOS without pf, which turns off iCloud
 * Private Relay. macOS lets a process with no privilege bind a port below 1024 on the wildcard
 * address only, so it binds there and passes each connection from this machine through to the
 * proxy, untouched (TLS ends at the proxy).
 */
export interface Forwarder {
	/** The port it listens on. */
	port: number;
	/** Settles once it has stopped: closed, or its `whileExists` file gone. */
	stopped: Promise<void>;
	/** Stops listening and ends every connection. */
	close(): Promise<void>;
}

export interface ForwardOptions {
	/** The port to listen on, on every address; 0 picks a free one. */
	port: number;
	/** The proxy's port, on 127.0.0.1. */
	to: number;
	/** A file whose existence means the supervisor runs; the forwarder stops once it is gone. */
	whileExists: string;
}

/** A peer on this machine, as a dual-stack socket reports it. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** How often it checks that the supervisor still runs. */
const CHECK_MS = 500;

export async function forward({ port, to, whileExists }: ForwardOptions): Promise<Forwarder> {
	const open = new Set<Socket>();
	const server = createServer((client) => {
		// Bound on every address, it would serve the network: only this machine gets through.
		if (!LOOPBACK.has(client.remoteAddress ?? "")) {
			client.destroy();
			return;
		}
		const upstream = connect({ host: "127.0.0.1", port: to });
		open.add(client).add(upstream);
		client.pipe(upstream).pipe(client);
		const end = () => {
			client.destroy();
			upstream.destroy();
			open.delete(client);
			open.delete(upstream);
		};
		client.on("error", end).on("close", end);
		upstream.on("error", end).on("close", end);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// `::` takes IPv4 too.
		server.listen(port, "::", resolve);
	});

	let close!: () => Promise<void>;
	const stopped = new Promise<void>((resolve) => {
		const check = setInterval(() => {
			if (!existsSync(whileExists)) void close();
		}, CHECK_MS);
		close = () => {
			clearInterval(check);
			for (const socket of open) socket.destroy();
			return new Promise<void>((done) => server.close(() => done())).then(resolve);
		};
	});
	return { port: (server.address() as AddressInfo).port, stopped, close };
}

// Run as a process of its own (`node forward.js <port> <to> <whileExists>`), detached from `serve`:
// it exits once it stops, or at once when it cannot bind (something else took the port).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [port, to, whileExists] = process.argv.slice(2);
	forward({ port: Number(port), to: Number(to), whileExists: whileExists as string }).then(
		(forwarder) => forwarder.stopped.then(() => process.exit(0)),
		() => process.exit(1),
	);
}
