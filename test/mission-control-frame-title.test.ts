import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import { expect, test } from "vitest";
import { frame } from "../src/mission-control/frame.ts";
import {
	type EnvironmentView,
	initialView,
	type LogLine,
	type Part,
	type Snapshot,
	type View,
} from "../src/mission-control/model.ts";

const app = (name: string): Part => ({
	id: `shop/${name}`,
	name,
	state: "running",
	address: `https://${name}.shop.localhost:7443`,
	note: ":20001  pid 4242",
});
const main: EnvironmentView = {
	namespace: "shop",
	label: "main",
	branch: "main",
	dir: "/code/shop",
	apps: [app("web"), app("api"), app("chatty"), app("worker")],
	services: [],
};
const logs: LogLine[] = Array.from({ length: 3000 }, (_, i) => ({
	seq: i,
	id: "shop/chatty",
	time: "10:00:00",
	text: `chatty line ${i} lorem`,
}));
const snapshot: Snapshot = {
	project: "shop",
	environments: [main],
	logs: new Map([["shop/chatty", logs]]),
	rate: 0,
};

function top(view: View, cols: number, rows: number): string {
	const out = stripVTControlCharacters(
		renderToString(frame({ snapshot, view, cols, rows, now: "10:00:05", color: "none" }), {
			columns: cols,
		}),
	);
	return (out.split("\n").find((l) => l.includes("LOGS")) as string).trimEnd();
}

const paused = { ...initialView("shop"), until: 500 };
const views: [string, View][] = [
	["all", paused],
	["one app", { ...paused, focus: "shop/chatty" }],
	["side by side", { ...paused, sideBySide: true }],
	["a search", { ...paused, focus: "shop/chatty", search: { query: "lorem", typing: false } }],
];

// Every width from the minimum up, so a title that fills its border exactly is among them.
for (const [name, view] of views) {
	test(`paused with ${name}, the stream's top border keeps its corner at every width`, () => {
		for (let cols = 72; cols <= 120; cols++) {
			expect(top(view, cols, 16), `${cols} columns`).toMatch(/─╮$|[^…]╮$/);
			expect(top(view, cols, 16), `${cols} columns`).not.toMatch(/……/);
		}
	});
}

// A name or a query found is never cut: the hints give way first, and one that still can't fit is left out.
for (const [name, view] of [
	...views,
	[
		"a long search",
		{ ...paused, focus: "shop/chatty", search: { query: "l".repeat(40), typing: false } },
	],
] as [string, View][]) {
	test(`paused with ${name}, the stream's title cuts nothing at any width`, () => {
		for (let cols = 72; cols <= 160; cols++) {
			const title = top(view, cols, 16);
			expect(title, `${cols} columns`).not.toContain("…");
			expect(title, `${cols} columns`).toMatch(/LOGS.* ⏸ paused/);
			const query = view.search?.query ?? "";
			if (title.includes("“") || title.includes(" / ")) expect(title).toContain(query);
		}
	});
}

test("a long query being typed shows its end and the caret, as an input field does, inside the border", () => {
	const query = "abcdefghij".repeat(4);
	const view = { ...paused, focus: "shop/chatty", search: { query, typing: true } };
	for (let cols = 72; cols <= 120; cols++) {
		const title = top(view, cols, 16);
		expect(title, `${cols} columns`).toMatch(/LOGS.* ⏸ paused/);
		expect(title, `${cols} columns`).toMatch(/─╮$|[^…]╮$/);
		// Whole where it fits, else its end after a "…".
		expect(title, `${cols} columns`).toMatch(new RegExp(`/ (${query}|…[a-j]+)▏`));
	}
	expect(top(view, 72, 16)).toMatch(/ \/ …[a-j]{10,}hij▏ /);
});

test("a found query outlasts the focused app's name: the name gives way first, the query never", () => {
	const view = {
		...paused,
		focus: "shop/chatty",
		search: { query: "chatty line 12", typing: false },
	};
	const narrow = top(view, 72, 16);
	expect(narrow).toContain("“chatty line 12”");
	expect(narrow).not.toContain("chatty only");
	expect(top(view, 120, 16)).toMatch(/chatty only.*“chatty line 12”/);
});
