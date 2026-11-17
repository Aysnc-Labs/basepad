import { existsSync } from "node:fs";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

export interface Forwarder {
	port: number;
	stopped: Promise<void>;
	close(): Promise<void>;
}

export interface ForwardOptions {
	port: number;
	to: number;
	whileExists: string;
}

/** A peer on this machine, as a dual-stack socket reports it: https://www.rfc-editor.org/rfc/rfc4291#section-2.5.5.2 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const CHECK_MS = 500;

export async function forward({ port, to, whileExists }: ForwardOptions): Promise<Forwarder> {
	const open = new Set<Socket>();
	const server = createServer((client) => {
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
		// `::` takes IPv4 too: https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [port, to, whileExists] = process.argv.slice(2);
	forward({ port: Number(port), to: Number(to), whileExists: whileExists as string }).then(
		(forwarder) => forwarder.stopped.then(() => process.exit(0)),
		() => process.exit(1),
	);
}
