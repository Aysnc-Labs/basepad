import { expect, test } from "vitest";
import {
	initialView,
	type Part,
	reduce,
	type Snapshot,
	type View,
} from "../src/mission-control/model.ts";

const part = (id: string, over: Partial<Part> = {}): Part => ({
	id,
	name: id.split("/")[1] as string,
	state: "running",
	address: `https://${id.split("/")[1]}.shop.localhost`,
	...over,
});
const env = (namespace: string, apps: string[], services: string[] = []) => ({
	namespace,
	label: namespace.split(".")[1] ?? "main",
	dir: `/code/${namespace}`,
	apps: apps.map((name) => part(`${namespace}/${name}`)),
	services: services.map((name) =>
		part(`shop/${name}`, { address: "postgresql://postgres@127.0.0.1:15432/shop" }),
	),
});
const snapshot: Snapshot = {
	project: "shop",
	environments: [
		env("shop", ["web", "api"], ["db"]),
		env("shop.worktree-1", ["web", "api"], ["db"]),
	],
	logs: new Map(),
	rate: 0,
};

/** The keys pressed in turn: the last view, and the intent of the last key. */
function press(keys: string[], from: View = initialView("shop")) {
	let step = { view: from } as ReturnType<typeof reduce>;
	for (const key of keys) step = reduce(step.view, key, snapshot);
	return step;
}

test("x stops the selected app: it is held, then stopped", () => {
	expect(press(["right", "x"]).intent).toEqual({
		kind: "stop",
		namespace: "shop",
		apps: ["web"],
		services: [],
		label: "web",
	});
});

test("with no app selected, s, x and r act on the whole environment: main's apps and services, a worktree's apps", () => {
	expect(press(["r"]).intent).toEqual({
		kind: "restart",
		namespace: "shop",
		apps: ["web", "api"],
		services: ["db"],
		label: "main",
	});
	expect(press(["down", "s"]).intent).toEqual({
		kind: "start",
		namespace: "shop.worktree-1",
		apps: ["web", "api"],
		services: [],
		label: "worktree-1",
	});
});

test("a service selected in a worktree acts on main's server", () => {
	expect(press(["down", "left", "x"]).intent).toEqual({
		kind: "stop",
		namespace: "shop",
		apps: [],
		services: ["db"],
		label: "db",
	});
});

test("an action says what it is doing until the next key", () => {
	expect(press(["right", "r"]).view.notice).toBe("Restarting web…");
	expect(press(["right", "r", "down"]).view.notice).toBeUndefined();
});

test("o opens the selected app's URL, and c copies the selected part's address", () => {
	expect(press(["down", "right", "o"]).intent).toEqual({
		kind: "open",
		url: "https://web.shop.localhost",
	});
	expect(press(["left", "c"]).intent).toEqual({
		kind: "copy",
		text: "postgresql://postgres@127.0.0.1:15432/shop",
	});
});

test("with none selected, o and c take the environment's first app", () => {
	expect(press(["o"]).intent).toEqual({ kind: "open", url: "https://web.shop.localhost" });
	expect(press(["c"]).intent).toEqual({ kind: "copy", text: "https://web.shop.localhost" });
});

test("a service has no page to open: o says so and asks nothing", () => {
	const step = press(["left", "o"]);
	expect(step.intent).toBeUndefined();
	expect(step.view.notice).toBe("db is a service, with no page to open; c copies its address.");
});

/** A main whose web printed `line 0` to `line 99`, and api `api 0` to `api 9` among them. */
function chatty(): Snapshot {
	const web = Array.from({ length: 100 }, (_, i) => ({
		seq: i * 2,
		id: "shop/web",
		time: "10:00:00",
		text: `line ${i}`,
	}));
	const api = Array.from({ length: 10 }, (_, i) => ({
		seq: i * 20 + 1,
		id: "shop/api",
		time: "10:00:00",
		text: `api ${i}`,
	}));
	return {
		...snapshot,
		logs: new Map([
			["shop/web", web],
			["shop/api", api],
		]),
	};
}

const scroll = (keys: string[], from: View = initialView("shop"), logs = chatty()) =>
	keys.reduce((view, key) => reduce(view, key, logs, 10).view, from);

test("page up pauses the stream a page back from the newest line; page down and end go back to live", () => {
	// 110 lines, the newest web's line 99 (seq 198); ten lines older is web's line 90 (seq 180).
	expect(scroll(["pageup"]).until).toBe(180);
	expect(scroll(["pageup", "pageup"]).until).toBe(161); // api 8
	expect(scroll(["pageup", "pageup", "pagedown"]).until).toBe(180);
	expect(scroll(["pageup", "pagedown"]).until).toBeUndefined();
	expect(scroll(["pageup", "pageup", "end"]).until).toBeUndefined();
	expect(scroll(["pageup", "G"]).until).toBeUndefined();
});

test("scrolling stops at the oldest page, and home goes there", () => {
	const top = scroll(Array(30).fill("pageup"));
	expect(top.until).toBe(scroll(["home"]).until);
	// The oldest page ends at the tenth line: line 0, api 0, then lines 1 to 8 (seq 16).
	expect(top.until).toBe(16);
});

test("narrowed to one part, scrolling moves through its lines alone", () => {
	expect(scroll(["right", "pageup"]).until).toBe(178); // web's line 89
	// api has fewer lines than a page: they all show already, so it stays live.
	expect(scroll(["right", "right", "pageup"]).until).toBeUndefined();
});
