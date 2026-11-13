import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { Kind } from "../catalogue.ts";
import { BasepadError, shellQuote } from "../internal/exec.ts";
import { freePort, waitFor } from "../internal/ports.ts";
import { recordRunning, runningPort } from "../internal/processes.ts";
import { install } from "../tools.ts";
import { REDIS_VERSION } from "../versions.ts";

/**
 * A Redis of the environment's own: mise's Redis, on loopback only, kept in memory (nothing is
 * saved), on a port derived from the environment's name. Each environment's server has a folder of
 * its own in the service's folder, holding its pid and port while it runs.
 */

const HOST = "127.0.0.1";
/** How long `up` waits for the server to answer before it gives up. */
const READY_MS = 30_000;

/** What a worktree's Redis is: its own, empty one, or main's (`shared`). */
export type RedisWorktree = "empty" | "shared";

/** A Redis of the environment's own. */
export interface RedisService {
	kind: "redis";
	worktree: RedisWorktree;
}

/**
 * A Redis of the environment's own, in memory. `worktree` is what a worktree uses: its own empty
 * Redis (`empty`, the default), or main's (`shared`).
 */
export function redis(options: { worktree?: RedisWorktree } = {}): RedisService {
	return { kind: "redis", worktree: options.worktree ?? "empty" };
}

/** What a Redis service gives to `env`. */
export interface RedisOutputs {
	/** `redis://127.0.0.1:<port>`, with no database index: clients pick their own. */
	url: string;
	host: string;
	port: number;
}

/** The names a Redis service derives. */
export interface RedisNames {
	/**
	 * The environment's server's folder: `main` in the service's folder, `worktrees/<suffix>` for
	 * a worktree's own (main's when the service is `shared`).
	 */
	server: string;
	/** Where worktrees' servers' folders are. */
	worktrees: string;
}

/** The file in a server's folder naming the checkout it belongs to. */
const OWNER = "owner";

export const redisKind: Kind<RedisService, RedisOutputs, RedisNames> = {
	schema: z.strictObject({
		kind: z.literal("redis"),
		worktree: z.enum(["empty", "shared"], {
			error: "Redis `worktree` must be empty or shared",
		}),
	}),

	perEnvironment(service) {
		return service.worktree !== "shared";
	},

	names(service, { dir, suffix }) {
		const worktrees = join(dir, "worktrees");
		const own = suffix !== undefined && service.worktree !== "shared";
		return { server: own ? join(worktrees, suffix) : join(dir, "main"), worktrees };
	},

	async prepare(_service, place) {
		const redis = await install("redis", REDIS_VERSION, place.machine.home);
		const { server } = place;
		await mkdir(server, { recursive: true });
		const port = (await runningPort(pidFile(server))) ?? (await freePort(place.port));
		const argv = [
			redis.bin("redis-server"),
			"--port",
			String(port),
			"--bind",
			HOST,
			// In memory: nothing is saved, so a worktree's starts empty and none outlives its server.
			"--save",
			"",
			"--appendonly",
			"no",
			"--dir",
			server,
		];
		return {
			run: `${recordRunning(pidFile(server), port)} && exec ${argv.map(shellQuote).join(" ")}`,
			dir: server,
			listens: port,
		};
	},

	async provision(_service, place, { started, stopped }) {
		const outputs = (port: number) => ({ url: `redis://${HOST}:${port}`, host: HOST, port });
		// Not started: where it will listen, which is where `prepare` put it.
		if (!started)
			return outputs((await runningPort(pidFile(place.server))) ?? (await freePort(place.port)));
		const port = await waitFor(
			async () => {
				const port = await runningPort(pidFile(place.server));
				if (port === undefined) throw new Error("It has not started.");
				await ping(port);
				return port;
			},
			`Redis for \`${place.key}\` didn't answer within ${READY_MS / 1000} s.`,
			READY_MS,
			stopped,
		);
		if (place.suffix !== undefined && place.server.startsWith(place.worktrees)) {
			await writeFile(join(place.server, OWNER), place.owner);
		}
		return outputs(port);
	},

	worktreeData: {
		async list(_service, place) {
			if (!existsSync(place.worktrees)) return [];
			const all = [];
			for (const name of await readdir(place.worktrees)) {
				const owner = await readFile(join(place.worktrees, name, OWNER), "utf8").catch(() => "");
				all.push({ name, owner });
			}
			if (place.suffix === undefined) return all;
			return all.filter(
				(data) => data.owner === place.owner || (data.owner === "" && data.name === place.suffix),
			);
		},

		async drop(_service, place, names) {
			for (const name of names) {
				if (name === "" || name.includes("/") || name === "." || name === "..") {
					throw new BasepadError(`\`${name}\` is no worktree's Redis.`);
				}
				await rm(join(place.worktrees, name), { recursive: true, force: true });
			}
		},
	},

	async address(_service, place) {
		return `redis://${HOST}:${(await runningPort(pidFile(place.server))) ?? place.port}`;
	},
};

/** The file in a server's folder with its process id and port while it runs. */
function pidFile(server: string): string {
	return join(server, "redis.pid");
}

/** Resolves once Redis on `port` answers PING with PONG. */
function ping(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: HOST, port });
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
		socket.on("timeout", () => socket.destroy(new Error("Redis didn't answer PING.")));
		socket.on("error", reject);
	});
}
