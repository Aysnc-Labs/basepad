import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { afterEach, beforeEach, expect, test } from "vitest";
import { animating, type Colors, type FrameInput, frame } from "../src/mission-control/frame.ts";
import {
	type EnvironmentView,
	initialView,
	type LogLine,
	type Part,
	type Snapshot,
} from "../src/mission-control/model.ts";

// Motion says something is happening, and only then: a part starting turns, one that just changed
// lights up and fades, a new log line settles in, a notice fades away.

const level = chalk.level;
beforeEach(() => {
	chalk.level = 3;
});
afterEach(() => {
	chalk.level = level;
});

const part = (name: string, over: Partial<Part> = {}): Part => ({
	id: `shop/${name}`,
	name,
	state: "running",
	address: `https://${name}.shop.localhost`,
	...over,
});
const env = (apps: Part[]): EnvironmentView => ({
	namespace: "shop",
	label: "main",
	branch: "main",
	dir: "~/code/shop",
	apps,
	services: [],
});
const snap = (apps: Part[], logs: LogLine[] = []): Snapshot => ({
	project: "shop",
	environments: [env(apps)],
	logs: new Map(logs.length === 0 ? [] : [["shop/web", logs]]),
	rate: 0,
});

function draw(input: Partial<FrameInput> & { snapshot: Snapshot }, color: Colors = "rgb") {
	return renderToString(
		frame({ view: initialView("shop"), cols: 120, rows: 30, now: "10:00:05", color, ...input }),
		{ columns: 120 },
	);
}

const plain = stripVTControlCharacters;
/** The truecolour foreground code for a hex colour, as chalk writes it. */
const fg = (hex: string) =>
	`38;2;${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const rowOf = (out: string, text: string) =>
	out.split("\n").find((row) => plain(row).includes(text)) ?? "";

test("a part starting breathes: its dot fades from amber to dim and back, and holds its shape", () => {
	const starting = snap([part("web", { state: "starting" })]);
	const at = (clock: number, color: Colors = "rgb") =>
		rowOf(draw({ snapshot: starting, clock }, color), "https://web");
	expect(at(0)).toContain(fg("#e0af68"));
	expect(at(700)).not.toContain(fg("#e0af68"));
	expect(at(1400)).toContain(fg("#e0af68"));
	// One glyph, in a range every font has, whatever the colours: never a different shape.
	for (const clock of [0, 350, 700]) expect(plain(at(clock, "none"))).toMatch(/◉ web/);
});

test("a part that just changed state is lit for a moment, then plain again", () => {
	const s = snap([part("web")]);
	const changed = new Map([["shop/web", 1000]]);
	const lit = rowOf(draw({ snapshot: s, clock: 1100, changed }), "https://web");
	expect(lit).toMatch(/48;2;/);
	const after = rowOf(draw({ snapshot: s, clock: 3000, changed }), "https://web");
	expect(after).not.toMatch(/48;2;/);
	// Without full colour nothing is lit, and the row reads the same.
	expect(rowOf(draw({ snapshot: s, clock: 1100, changed }, "16"), "https://web")).not.toMatch(
		/48;/,
	);
});

test("a new log line comes in dim and settles to its colour", () => {
	const fresh: LogLine = { seq: 1, id: "shop/web", time: "10:00:04", text: "GET / 200", at: 1000 };
	const s = snap([part("web")], [fresh]);
	expect(rowOf(draw({ snapshot: s, clock: 1000 }), "GET / 200")).not.toContain(fg("#c0caf5"));
	expect(rowOf(draw({ snapshot: s, clock: 2000 }), "GET / 200")).toContain(fg("#c0caf5"));
});

test("a notice fades out after a few seconds", () => {
	const s = snap([part("web")]);
	const view = { ...initialView("shop"), notice: "Restarting web…" };
	expect(rowOf(draw({ snapshot: s, view, noticeAge: 0 }), "Restarting")).toContain(fg("#7aa2f7"));
	const fading = rowOf(draw({ snapshot: s, view, noticeAge: 4600 }), "Restarting");
	expect(fading).not.toContain(fg("#7aa2f7"));
	expect(plain(fading)).toContain("Restarting web…");
});

test("it says whether anything moves, so the view repaints fast only then", () => {
	const still = snap([part("web")]);
	expect(animating({ snapshot: still, clock: 5000 })).toBe(false);
	expect(animating({ snapshot: snap([part("web", { state: "starting" })]), clock: 5000 })).toBe(
		true,
	);
	expect(animating({ snapshot: still, clock: 1100, changed: new Map([["shop/web", 1000]]) })).toBe(
		true,
	);
	const line: LogLine = { seq: 1, id: "shop/web", time: "10:00:04", text: "hi", at: 1000 };
	expect(animating({ snapshot: snap([part("web")], [line]), clock: 1100 })).toBe(true);
	expect(animating({ snapshot: snap([part("web")], [line]), clock: 3000 })).toBe(false);
	expect(animating({ snapshot: still, clock: 5000, noticeAge: 4500 })).toBe(true);
});
