import { expect, test } from "vitest";
import { logBook } from "../src/mission-control/feed.ts";
import type { LogEntry } from "../src/supervisor.ts";

/** A supervisor's `follow` that records each call and lets the test print lines to it. */
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
	/** A line from `id`, as every follower still running that follows it would get it. */
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
	// A pause holds a line by its arrival number, so the same line keeps the same one.
	expect(book.logs.get("shop/web")?.[0]).toEqual(before);
	expect(texts(book, "shop.shop-1/web")).toEqual(["ready"]);
	// The same parts again follow nothing new.
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

test("a part shown again is followed afresh, and its old follower's lines for it are not taken twice", () => {
	const { calls, follow, print } = supervisor();
	const book = logBook(follow, 200, () => {});
	book.follow(["shop/api", "shop/web"]);
	book.follow(["shop/api"]);
	book.follow(["shop/api", "shop/web"]);
	expect(calls.map((c) => c.ids)).toEqual([["shop/api", "shop/web"], ["shop/web"]]);
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
