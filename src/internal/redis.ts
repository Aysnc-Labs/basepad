import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { shellQuote, tomlString } from "./exec.ts";
import type { Home } from "./home.ts";
import { mise } from "./mise.ts";
import { freePort, waitFor } from "./ports.ts";
import { PITCHFORK_VERSION, REDIS_VERSION } from "./versions.ts";

/** Clear of Redis's default 6379, so a Redis the user already runs keeps its port. */
const PORT_BASE = 63790;

/** A port for a new Redis, clear of every port basepad has recorded. */
export function redisPort(home: Home): Promise<number> {
	return freePort(PORT_BASE, home.records);
}

/**
 * The project's own Redis daemon, for its `conf.d/`: one per project or worktree, never shared,
 * and never written to disk, since each worktree starts with an empty one.
 */
export async function redisDaemon(home: Home, name: string, port: number): Promise<string> {
	await mise(
		home.dir,
		"install",
		"--quiet",
		`redis@${REDIS_VERSION}`,
		`pitchfork@${PITCHFORK_VERSION}`,
	);
	const bin = join((await mise(home.dir, "where", `redis@${REDIS_VERSION}`)).trim(), "bin");
	const dir = join(home.dir, "redis");
	await mkdir(dir, { recursive: true });
	const argv = [
		join(bin, "redis-server"),
		"--port",
		String(port),
		"--bind",
		"127.0.0.1",
		"--save",
		"",
		"--appendonly",
		"no",
		"--dir",
		dir,
	];
	// No `port`: mise would export its own <NAME>_PORT, and basepad writes every variable itself.
	// The port is in `run`, and `startRedis` checks readiness.
	return [
		`[daemons.${name}]`,
		`run = ${tomlString(`exec ${argv.map(shellQuote).join(" ")}`)}`,
	].join("\n");
}

export function redisUrl(port: number): string {
	// No database index: Laravel, for one, picks a different index for its cache.
	return `redis://127.0.0.1:${port}`;
}

/** Starts the project's Redis daemon `name` and waits until it answers PING. */
export async function startRedis(projectDir: string, name: string, port: number): Promise<void> {
	await mise(projectDir, "daemons", "start", name);
	await waitFor(
		() => ping(port),
		`Redis didn't become ready. For its log, run \`mise daemons logs ${name}\` in ${projectDir}.`,
	);
}

function ping(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(2000);
		let reply = "";
		socket.on("connect", () => socket.write("PING\r\n"));
		socket.on("data", (chunk) => {
			reply += chunk.toString();
			if (!reply.includes("\r\n")) return;
			socket.destroy();
			if (reply.startsWith("+PONG")) resolve();
			else reject(new Error(`Redis replied ${reply.trim()}`));
		});
		socket.on("timeout", () => socket.destroy(new Error("Redis didn't answer PING")));
		socket.on("error", reject);
	});
}
