import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Project } from "../src/config.ts";
import { postgresWithNeonProxy } from "../src/index.ts";
import { environmentOf, logBook } from "../src/mission-control/feed.ts";
import type { DaemonInfo, LogEntry } from "../src/supervisor.ts";

function supervisor() {
	const calls: { ids: string[]; history: number; stopped: boolean; print(e: LogEntry): void }[] =
		[];
	const follow = (ids: string[], history: number, line: (entry: LogEntry) => void) => {
		const call = { ids, history, stopped: false, print: line };
		calls.push(call);
		return () => {
			call.stopped = true;
		};
	};
	const print = (id: string, text: string) => {
		for (const call of calls)
			if (!call.stopped && call.ids.includes(id)) call.print({ id, time: "10:00:00", text });
	};
	return { calls, follow, print };
}

const texts = (book: ReturnType<typeof logBook>, id: string) =>
	(book.logs.get(id) ?? []).map((l) => l.text);

test("a part followed later fetches only its own history; every line already read stays, as it was", () => {
	const { calls, follow, print } = supervisor();
	const book = logBook(follow, 200, () => {});
	book.follow(["shop/api", "shop/web"]);
	print("shop/web", "GET / 200");
	const before = book.logs.get("shop/web")?.[0];
	book.follow(["shop.shop-1/web", "shop/api", "shop/web"]);
	expect(calls.map((c) => [c.ids, c.history])).toEqual([
		[["shop/api", "shop/web"], 200],
		[["shop.shop-1/web"], 200],
	]);
	print("shop.shop-1/web", "ready");
	print("shop/web", "GET /cart 200");
	expect(texts(book, "shop/web")).toEqual(["GET / 200", "GET /cart 200"]);
	expect(book.logs.get("shop/web")?.[0]).toEqual(before);
	expect(texts(book, "shop.shop-1/web")).toEqual(["ready"]);
	book.follow(["shop.shop-1/web", "shop/api", "shop/web"]);
	expect(calls).toHaveLength(2);
});

test("a part no longer shown loses its lines; its follower stops once it follows nothing shown", () => {
	const { calls, follow, print } = supervisor();
	const book = logBook(follow, 200, () => {});
	book.follow(["shop/web"]);
	book.follow(["shop.shop-1/web", "shop/web"]);
	print("shop.shop-1/web", "ready");
	book.follow(["shop/web"]);
	expect(book.logs.has("shop.shop-1/web")).toBe(false);
	expect(calls.map((c) => c.stopped)).toEqual([false, true]);
	book.close();
	expect(calls.map((c) => c.stopped)).toEqual([true, true]);
});

function tailed(calls: { ids: string[]; stopped: boolean }[]): string[] {
	return calls
		.filter((c) => !c.stopped)
		.flatMap((c) => c.ids)
		.sort();
}

test("each environment is followed on its own: removing a worktree stops exactly its follower", () => {
	const { calls, follow } = supervisor();
	const book = logBook(follow, 200, () => {});
	book.follow(["shop.shop-1/web", "shop/db", "shop/web"]);
	expect(calls.map((c) => c.ids)).toEqual([["shop.shop-1/web"], ["shop/db", "shop/web"]]);
	book.follow(["shop/db", "shop/web"]);
	expect(calls.map((c) => c.stopped)).toEqual([true, false]);
	expect(tailed(calls)).toEqual(["shop/db", "shop/web"]);
});

test("a part gone from a follower's set is no longer tailed; the rest go on without their history again", () => {
	const { calls, follow, print } = supervisor();
	const book = logBook(follow, 200, () => {});
	book.follow(["shop/api", "shop/web"]);
	print("shop/api", "ready");
	book.follow(["shop/api"]);
	expect(tailed(calls)).toEqual(["shop/api"]);
	expect(calls.at(-1)?.history).toBe(0);
	print("shop/api", "GET / 200");
	expect(texts(book, "shop/api")).toEqual(["ready", "GET / 200"]);
	book.follow(["shop/api", "shop/web"]);
	expect(tailed(calls)).toEqual(["shop/api", "shop/web"]);
	expect(calls.at(-1)).toMatchObject({ ids: ["shop/web"], history: 200 });
	print("shop/web", "GET / 200");
	expect(texts(book, "shop/web")).toEqual(["GET / 200"]);
});

test("each line read says so, and the scrollback keeps the newest 2000 lines of a part", () => {
	const { follow, print } = supervisor();
	let told = 0;
	const book = logBook(follow, 200, () => told++);
	book.follow(["shop/web"]);
	for (let i = 0; i < 3500; i++) print("shop/web", `line ${i}`);
	expect(told).toBe(3500);
	const kept = texts(book, "shop/web");
	expect(kept.length).toBeGreaterThanOrEqual(2000);
	expect(kept.at(-1)).toBe("line 3499");
});

test("a service's extra daemon is a part of its own, with its address and state, and moves with its service", async () => {
	const home = await mkdtemp(join(tmpdir(), "bp-feed-"));
	const project: Project = {
		file: "/code/shop/basepad.config.ts",
		root: "/code/shop",
		name: "shop",
		services: { db: postgresWithNeonProxy() },
		apps: {},
		env: () => ({}),
		worktrees: { prefix: "worktree", clone: [], setup: [] },
	};
	const daemons = new Map<string, DaemonInfo>(
		[
			{ id: "shop/db", namespace: "shop", name: "db", state: "running" },
			{ id: "shop/db-neon-proxy", namespace: "shop", name: "db-neon-proxy", state: "failed" },
		].map((d): [string, DaemonInfo] => [d.id, d as DaemonInfo]),
	);
	const machine = { home, proxyPort: 7443, portFree: false, forwards443: false };
	const env = await environmentOf(project, undefined, "main", "/code/shop", daemons, machine);
	expect(env.services.map(({ id, name, state }) => ({ id, name, state }))).toEqual([
		{ id: "shop/db", name: "db", state: "running" },
		{ id: "shop/db-neon-proxy", name: "db-neon-proxy", state: "failed" },
	]);
	expect(env.services[0]?.extraDaemons).toEqual(["db-neon-proxy"]);
	expect(env.services[1]?.address).toMatch(/^ws:\/\/localhost:\d+\/v2$/);
	expect(env.services[1]?.note).toBe("with db");
	await rm(home, { recursive: true, force: true });
});
