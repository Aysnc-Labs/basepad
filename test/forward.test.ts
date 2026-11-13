import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Forwarder, forward } from "../src/forward.ts";

let dir: string;
let sock: string;
let echo: Server;
let forwarder: Forwarder | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "basepad-forward-"));
	sock = join(dir, "sock");
	await writeFile(sock, "");
	// The proxy, as the forwarder sees it: answers each line with the line upper-cased.
	echo = createServer((socket) =>
		socket.on("data", (data) => socket.write(data.toString().toUpperCase())),
	);
	await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
	await forwarder?.close();
	forwarder = undefined;
	echo.close();
	await rm(dir, { recursive: true, force: true });
});

const port = (server: Server) => (server.address() as AddressInfo).port;

/** Sends `text` from `host` to the forwarder; resolves with what came back, or `closed` when refused. */
function exchange(host: string, text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket: Socket = connect({ host, port: forwarder?.port as number }, () =>
			socket.write(text),
		);
		let got = "";
		socket.on("data", (data) => {
			got += data.toString();
			if (got.length >= text.length) {
				socket.end();
				resolve(got);
			}
		});
		socket.on("close", () => resolve(got === "" ? "closed" : got));
		socket.on("error", (error: NodeJS.ErrnoException) =>
			error.code === "ECONNRESET" ? resolve("closed") : reject(error),
		);
	});
}

test("a connection from this machine reaches the proxy, both ways", async () => {
	forwarder = await forward({ port: 0, to: port(echo), whileExists: sock });
	expect(await exchange("127.0.0.1", "hello")).toBe("HELLO");
	expect(await exchange("::1", "again")).toBe("AGAIN");
});

/** This machine's address on its network, as another device would reach it. */
const lan = Object.values(networkInterfaces())
	.flat()
	.find((info) => info !== undefined && info.family === "IPv4" && !info.internal)?.address;

test.skipIf(lan === undefined)(
	"a connection to this machine's network address is closed, never reaching the proxy",
	async () => {
		forwarder = await forward({ port: 0, to: port(echo), whileExists: sock });
		expect(await exchange(lan as string, "hello")).toBe("closed");
	},
);

test("once the supervisor's socket is gone, it stops listening", async () => {
	forwarder = await forward({ port: 0, to: port(echo), whileExists: sock });
	const { port: listening } = forwarder;
	await rm(sock);
	await forwarder.stopped;
	const refused = await new Promise<string | undefined>((resolve) =>
		connect({ host: "127.0.0.1", port: listening })
			.on("connect", () => resolve(undefined))
			.on("error", (error: NodeJS.ErrnoException) => resolve(error.code)),
	);
	expect(refused).toBe("ECONNREFUSED");
});
