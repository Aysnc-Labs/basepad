import { expect, test } from "vitest";
import {
	initialView,
	type Part,
	type Press,
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

test("an app with no port has no address: o and c say so, and with none selected take the first app that has one", () => {
	const queue = part("jobs/queue", { address: undefined });
	const jobs: Snapshot = {
		...snapshot,
		environments: [{ ...env("jobs", ["web"]), apps: [queue, part("jobs/web")] }],
	};
	const keys = (pressed: string[]) => {
		let step = { view: initialView("jobs") } as ReturnType<typeof reduce>;
		for (const key of pressed) step = reduce(step.view, key, jobs);
		return step;
	};
	for (const key of ["o", "c"]) {
		const step = keys(["right", key]);
		expect(step.intent).toBeUndefined();
		expect(step.view.notice).toBe("queue listens on nothing, so it has no address.");
	}
	expect(keys(["o"]).intent).toEqual({ kind: "open", url: "https://web.shop.localhost" });
	expect(keys(["c"]).intent).toEqual({ kind: "copy", text: "https://web.shop.localhost" });
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

const scroll = (keys: Press[], from: View = initialView("shop"), logs = chatty()) =>
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

const type = (text: string) => ["/", ...text];

test("/ starts a search; enter jumps to the newest matching line, n to older ones and N back", () => {
	const found = scroll([...type("Line 4"), "return"]);
	expect(found.search).toEqual({ query: "Line 4", typing: false });
	expect(found.until).toBe(98); // line 49: matching ignores case
	expect(scroll([...type("line 4"), "return", "n"]).until).toBe(96); // line 48
	expect(scroll([...type("line 4"), "return", "n", "n", "N"]).until).toBe(96);
});

test("while typing, keys are text: q does not close, backspace deletes, escape cancels", () => {
	const typing = scroll([...type("aqx"), "backspace"]);
	expect(typing.quit).toBe(false);
	expect(typing.search).toEqual({ query: "aq", typing: true });
	expect(scroll([...type("aq"), "escape"]).search).toBeUndefined();
	expect(scroll([...type("aq"), "ctrl-c"]).quit).toBe(true);
});

test("text pasted into a search is its query; elsewhere a paste presses no key", () => {
	expect(scroll(["/", { paste: "line 4" }]).search).toEqual({ query: "line 4", typing: true });
	// Control characters (a newline, a tab, an escape, delete) are left out: a query is one line.
	expect(scroll(["/", { paste: "line\n4\r\t\u001b\u007f" }]).search).toEqual({
		query: "line4",
		typing: true,
	});
	const idle = scroll(["right", { paste: "qdvx/" }]);
	expect(idle).toEqual(scroll(["right"]));
});

test("a search with no match says so and leaves the stream live", () => {
	const none = reduce(scroll(type("zz")), "return", chatty(), 10).view;
	expect(none.notice).toBe("No line matches “zz”.");
	expect(none.search).toBeUndefined();
	expect(none.until).toBeUndefined();
	const end = scroll([...type("line 0"), "return", "n"]);
	expect(end.notice).toBe("No older line matches “line 0”.");
	expect(end.until).toBe(0);
});

test("escape steps back one layer at a time: the search, then the pause, then the focus", () => {
	const searched = scroll(["right", ...type("line 4"), "return"]);
	expect(scroll(["escape"], searched)).toMatchObject({ focus: "shop/web" });
	expect(scroll(["escape"], searched).search).toBeUndefined();
	expect(scroll(["escape"], searched).until).toBeUndefined();
	const paused = scroll(["right", "pageup"]);
	expect(scroll(["escape"], paused)).toMatchObject({ focus: "shop/web" });
	expect(scroll(["escape"], paused).until).toBeUndefined();
	expect(scroll(["escape", "escape"], paused).focus).toBeUndefined();
});

test("v shows the apps' logs side by side and back; it stays on across environments and escape", () => {
	expect(scroll(["v"]).sideBySide).toBe(true);
	expect(scroll(["v", "v"]).sideBySide).toBeUndefined();
	expect(scroll(["v", "down", "right", "escape"]).sideBySide).toBe(true);
});

test("side by side, scrolling and search move through every app's lines, whatever is selected", () => {
	// web and api together, as in the merged stream, but never db's.
	expect(scroll(["v", "right", "right", "pageup"]).until).toBe(180);
});
