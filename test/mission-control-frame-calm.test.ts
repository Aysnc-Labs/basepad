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

// Mission control says each thing once: what repeats, and what only matters on a closer look,
// stays out of the way.

const app = (ns: string, name: string, over: Partial<Part> = {}): Part => ({
	id: `${ns}/${name}`,
	name,
	state: "running",
	address: `https://${name}.${ns === "shop" ? "" : `${ns.split(".")[1]}.`}shop.localhost`,
	note: ":20001  pid 4242",
	...over,
});
const main: EnvironmentView = {
	namespace: "shop",
	label: "main",
	branch: "main",
	dir: "~/code/shop",
	apps: [app("shop", "web"), app("shop", "api")],
	services: [
		{
			id: "shop/db",
			name: "db",
			state: "running",
			address: "postgresql://postgres@127.0.0.1:15432/shop",
			note: "postgres",
		},
	],
};
const worktree: EnvironmentView = {
	...main,
	namespace: "shop.worktree-1",
	label: "worktree-1",
	branch: "feature/cart",
	dir: "~/code/shop.worktrees/worktree-1",
	apps: [app("shop.worktree-1", "web", { state: "failed", error: "exit code 1", note: undefined })],
};
const line = (id: string, text: string, seq: number): LogLine => ({
	seq,
	id,
	time: "10:00:00",
	text,
});
const snap = (environments: EnvironmentView[], logs: LogLine[] = []): Snapshot => ({
	project: "shop",
	environments,
	logs: new Map(
		[...new Set(logs.map((l) => l.id))].map((id) => [id, logs.filter((l) => l.id === id)]),
	),
	rate: 0,
});
const draw = (snapshot: Snapshot, view: View = initialView("shop"), cols = 140, rows = 36) =>
	renderToString(frame({ snapshot, view, cols, rows, now: "10:00:05", color: "none" }), {
		columns: cols,
	})
		.split("\n")
		.map((row) => row.trimEnd())
		.join("\n");

test("the sidebar numbers each environment and names it once: its branch only where it differs", () => {
	const out = draw(snap([main, worktree]));
	expect(out).toMatch(/│ ▌1 ● main +│/);
	expect(out).toMatch(/│ {2}2 ✖ worktree-1 +│/);
	expect(out).toMatch(/│ {6}feature\/cart +│/);
	// Once in the sidebar and once as the panel's title: never again as its own branch.
	expect(out.match(/\bmain\b/g)?.length).toBe(2);
	// All running says nothing more; a failure says which.
	expect(out).not.toContain("apps running");
	expect(out).toMatch(/│ {6}web failed +│/);
});

test("the parts panel is titled with the environment, its branch only where it differs", () => {
	const out = draw(snap([main, worktree]), initialView("shop.worktree-1"));
	expect(out).toMatch(
		/╭─ worktree-1 {2}· feature\/cart ─+ ~\/code\/shop\.worktrees\/worktree-1 ─╮/,
	);
	expect(draw(snap([main]))).toMatch(/╭─ main ─+ ~\/code\/shop ─╮/);
});

test("a part's port and pid show only when it is selected; services follow apps without a gap", () => {
	const out = draw(snap([main]));
	expect(out).not.toContain("pid 4242");
	expect(out).toMatch(/APPS[^\n]*\n[^\n]*web[^\n]*\n[^\n]*api[^\n]*\n[^\n]*SERVICES/);
	const focused = draw(snap([main]), { ...initialView("shop"), focus: "shop/api" });
	expect(focused).toMatch(/› ● api +running +https:\/\/api\.shop\.localhost +:20001 +pid 4242/);
	expect(focused).toMatch(/ {3}● web +running +https:\/\/web\.shop\.localhost *│/);
});

test("the logs carry one time: the app's own date and time at the start of a line is left out, indented or not", () => {
	const out = draw(
		snap(
			[main],
			[
				line("shop/web", "2026-11-13 23:56:59 /logo.svg .. ~ 0.01ms", 1),
				line("shop/api", "[2026-11-13T23:56:59.120Z] INFO ready", 2),
				line("shop/web", "  2026-11-14 00:31:07 /_boost/browser-logs .. ~ 0.04ms", 3),
			],
		),
	);
	expect(out).toMatch(/10:00:00 +▎web +\/_boost\/browser-logs/);
	expect(out).toMatch(/10:00:00 +▎web +\/logo\.svg \.\. ~ 0\.01ms/);
	expect(out).toMatch(/10:00:00 +▎api +INFO ready/);
	expect(out).not.toContain("2026-11-13");
});

test("the logs' title names what it shows, with no legend of every part", () => {
	const out = draw(snap([main]));
	expect(out).toMatch(/╭─ LOGS {2}all ─+╮/);
	expect(out).not.toContain("■ web");
});

test("the keys below are the few used most, and ? shows every one in place of the logs", () => {
	const out = draw(snap([main, worktree]));
	const keys = out.split("\n").slice(-2).join("\n");
	for (const key of [
		/↑↓ +select/,
		/tab +environment/,
		/enter +open/,
		/space +start\/stop/,
		/r +restart/,
		/\/ +search/,
		/\? +all keys/,
		/q +close/,
	])
		expect(keys).toMatch(key);
	expect(keys).not.toContain("remove worktree");
	const help = draw(snap([main, worktree]), { ...initialView("shop"), help: true });
	for (const key of [
		/a +add a worktree/,
		/d +remove the selected worktree/,
		/1–9 +go to an environment/,
		/c +copy its address/,
		/n N +older and newer match/,
		/PgUp PgDn +scroll/,
	])
		expect(help).toMatch(key);
	expect(help).toMatch(/KEYS/);
});

test("with one environment, tab is left out of the keys: there is nowhere to go", () => {
	const keys = draw(snap([main]))
		.split("\n")
		.slice(-2)
		.join("\n");
	expect(keys).not.toContain("tab");
});

test("blank lines an app prints are left out of the logs", () => {
	const out = draw(
		snap(
			[main],
			[line("shop/web", "", 1), line("shop/web", "   ", 2), line("shop/api", "ready", 3)],
		),
	);
	expect(out).not.toMatch(/▎web *│/);
	expect(out).toMatch(/▎api +ready/);
});

test("stopped reads as off, and the header counts it", () => {
	const stopped = { ...main, apps: main.apps.map((a) => ({ ...a, state: "stopped" as const })) };
	const out = draw(snap([stopped]));
	expect(out).toMatch(/– web/);
	expect(out).not.toContain("■");
	expect(out).toMatch(/– 2 stopped/);
	expect(draw(snap([main]))).not.toContain("stopped");
});
