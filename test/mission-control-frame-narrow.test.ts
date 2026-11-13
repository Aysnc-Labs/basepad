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
	apps: [app("web"), app("api"), app("worker")],
	services: [],
};

let seq = 0;
const lines = (id: string, count: number): [string, LogLine[]] => [
	id,
	Array.from({ length: count }, (_, i) => ({
		seq: seq++,
		id,
		time: "10:00:00",
		text: `line ${i}`,
	})),
];
const snap = (logs: [string, LogLine[]][]): Snapshot => ({
	project: "shop",
	environments: [main],
	logs: new Map(logs),
	rate: 0,
});

function draw(snapshot: Snapshot, view: View, cols: number, rows: number): string {
	const text = renderToString(
		frame({ snapshot, view, cols, rows, now: "10:00:05", color: "none" }),
		{
			columns: cols,
		},
	);
	return stripVTControlCharacters(text);
}

test("side by side with more apps than fit says how many more and to widen the terminal", () => {
	const logs = [lines("shop/web", 3), lines("shop/api", 3), lines("shop/worker", 3)];
	const out = draw(snap(logs), { ...initialView("shop"), sideBySide: true }, 72, 24);
	expect(out).toMatch(/\+\d more: widen the terminal/);
});

test("scrolled back at the minimum width, the stream's top border keeps its corner", () => {
	const web = lines("shop/web", 3000);
	const until = (web[1][500] as LogLine).seq;
	const out = draw(snap([web]), { ...initialView("shop"), until }, 72, 16);
	const top = out.split("\n").find((l) => l.includes("LOGS")) as string;
	expect(top.trimEnd()).toMatch(/╮$/);
});
