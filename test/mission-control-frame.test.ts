import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { afterEach, expect, test } from "vitest";
import { type Colors, colorsFor, frame } from "../src/mission-control/frame.ts";
import {
	type EnvironmentView,
	initialView,
	type LogLine,
	type Part,
	type Snapshot,
	type View,
} from "../src/mission-control/model.ts";

const url = (app: string, suffix?: string) =>
	`https://${app}.${suffix === undefined ? "" : `${suffix}.`}shop.localhost:7443`;

const app = (namespace: string, name: string, over: Partial<Part> = {}): Part => ({
	id: `${namespace}/${name}`,
	name,
	state: "running",
	address: url(name, namespace.split(".")[1]),
	note: ":20001  pid 4242",
	...over,
});
const db: Part = {
	id: "shop/db",
	name: "db",
	state: "running",
	address: "postgresql://postgres@127.0.0.1:15432/shop",
	note: "postgres",
};
const main: EnvironmentView = {
	namespace: "shop",
	label: "main",
	branch: "main",
	dir: "/code/shop",
	apps: [app("shop", "web"), app("shop", "api")],
	services: [db],
};
const worktree = (n: number, over: Partial<EnvironmentView> = {}): EnvironmentView => {
	const ns = `shop.worktree-${n}`;
	return {
		namespace: ns,
		label: `worktree-${n}`,
		branch: `feature/thing-${n}`,
		dir: `/code/shop.worktrees/worktree-${n}`,
		apps: [app(ns, "web"), app(ns, "api")],
		services: [{ ...db, address: `postgresql://postgres@127.0.0.1:15432/shop_worktree_${n}` }],
		...over,
	};
};

let seq = 0;
const lines = (id: string, ...texts: string[]): [string, LogLine[]] => [
	id,
	texts.map((text) => ({ seq: seq++, id, time: "10:00:00", text })),
];

const snap = (environments: EnvironmentView[], logs: [string, LogLine[]][] = []): Snapshot => ({
	project: "shop",
	environments,
	logs: new Map(logs),
	rate: 12,
});

/** The frame as plain text, a line per row, without trailing spaces. */
function draw(
	snapshot: Snapshot,
	view: View = initialView("shop"),
	cols = 140,
	rows = 40,
	color: Colors = "none",
): string {
	const text = renderToString(frame({ snapshot, view, cols, rows, now: "10:00:05", color }), {
		columns: cols,
	});
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

test("main only: the header names the project and counts, main is listed, its parts show state and address", () => {
	const out = draw(snap([main], [lines("shop/web", "GET / 200 3ms"), lines("shop/api", "ready")]));
	expect(out).toMatch(/basepad.*shop.*2 running/);
	expect(out).toContain("10:00:05");
	expect(out).toMatch(/│ ▌● main +│.*\n│ ▌ {2}main +│/); // selected: its name, then its branch
	expect(out).toMatch(/web +running +https:\/\/web\.shop\.localhost:7443 +:20001 +pid 4242/);
	expect(out).toMatch(/db +running +postgresql:\/\/postgres@127\.0\.0\.1:15432\/shop +postgres/);
	expect(out).toMatch(/10:00:00 +▎web +GET \/ 200 3ms/);
	expect(out).toMatch(/10:00:00 +▎api +ready/);
	expect(out.split("\n")).toHaveLength(40);
});

test("main with three worktrees: each is listed with its branch, and the selected one's parts are shown", () => {
	const out = draw(
		snap([main, worktree(1), worktree(2), worktree(3)]),
		initialView("shop.worktree-2"),
	);
	for (const n of [1, 2, 3])
		expect(out).toMatch(new RegExp(`● worktree-${n}[\\s\\S]*feature/thing-${n}`));
	expect(out).toMatch(/│ ▌● worktree-2 /);
	expect(out).not.toMatch(/▌● main/);
	expect(out).toContain("worktree-2  · feature/thing-2");
	expect(out).toContain("https://web.worktree-2.shop.localhost:7443");
	expect(out).toContain("postgresql://postgres@127.0.0.1:15432/shop_worktree_2");
	expect(out).toContain("4 environments");
	expect(out).toContain("8 running");
});

test("an errored app stands out: an alert line names it and its error wherever the view is, and its row says failed", () => {
	const api = app("shop.worktree-1", "api", {
		state: "failed",
		error: "exit code 1",
		note: undefined,
	});
	const broken = worktree(1, { apps: [app("shop.worktree-1", "web"), api] });
	const logs = [
		lines(
			api.id,
			"api listening",
			"TypeError: Cannot read properties of undefined",
			"    at server.mjs:3",
		),
	];
	const onMain = draw(snap([main, broken], logs));
	expect(onMain).toMatch(
		/✖ worktree-1 › api exited \(exit code 1\) +TypeError: Cannot read properties of undefined/,
	);
	expect(onMain).toContain("1 failed");
	expect(onMain).toMatch(/✖ worktree-1[\s\S]*api failed/); // its environment, in the sidebar
	const onIt = draw(snap([main, broken], logs), initialView("shop.worktree-1"));
	expect(onIt).toMatch(/✖ api +failed +exit code 1 +TypeError: Cannot read properties/);
});

test("an idle worktree reads as idle, not failed: its apps start on their first request", () => {
	const ns = "shop.worktree-2";
	const idle = worktree(2, {
		apps: [
			app(ns, "web", { state: "idle", note: undefined }),
			app(ns, "api", { state: "idle", note: undefined }),
		],
	});
	const out = draw(snap([main, idle]), initialView(ns));
	expect(out).toMatch(/○ worktree-2[\s\S]*idle until opened/);
	expect(out).toMatch(
		/○ web +idle +https:\/\/web\.worktree-2\.shop\.localhost:7443 +starts on its first request/,
	);
	expect(out).not.toContain("failed");
	expect(out).toContain("No output yet: its apps start on their first request.");
	expect(out).toContain("2 idle");
});

test("a very long branch name wraps in the sidebar and is never cut", () => {
	const branch = "feature/JIRA-12345-rework-the-checkout-flow-for-guest-customers";
	const out = draw(snap([main, worktree(1, { branch })]));
	const sidebar = out
		.split("\n")
		.map((row) => /^│ [ ▌] {2}(\S*)/.exec(row)?.[1] ?? "")
		.join("");
	expect(sidebar).toContain(branch);
	expect(out).toMatch(/│ {4}feature\/JIRA-12345- +│/); // broken after a dash, not mid-word
	expect(out).not.toMatch(/^│[^│]*…/m);
});

test("focusing one part narrows the stream to its lines, without the name column", () => {
	const logs = [lines("shop/web", "GET / 200 3ms"), lines("shop/api", "POST /orders 201")];
	const out = draw(snap([main], logs), { ...initialView("shop"), focus: "shop/api" });
	expect(out).toContain("LOGS  api only");
	expect(out).toMatch(/› ● api/);
	expect(out).toMatch(/10:00:00 +POST \/orders 201/);
	expect(out).not.toContain("GET / 200 3ms");
});

test("every key is on screen, wrapping onto a second row where the terminal is narrow", () => {
	const keys = [
		/↑↓ +environment/,
		/←→ +app or service/,
		/s +start/,
		/x +stop/,
		/r +restart/,
		/o +open/,
		/c +copy/,
		/v +side by side/,
		/\/ +search/,
		/n N +next match/,
		/PgUp PgDn +scroll/,
		/esc +back/,
		/a +add worktree/,
		/d +remove worktree/,
		/q +close/,
	];
	for (const [cols, rows] of [
		[140, 40],
		[100, 30],
		[72, 20],
	] as const) {
		const out = draw(snap([main]), initialView("shop"), cols, rows);
		for (const key of keys) expect(out).toMatch(key);
		expect(out.split("\n").slice(-2).join("\n")).not.toContain("…");
		expect(out.split("\n")).toHaveLength(rows);
	}
});

test("what the last key did shows above the keys", () => {
	const out = draw(snap([main]), { ...initialView("shop"), notice: "Restarting web…" });
	expect(out).toMatch(/Restarting web…\n.*environment/);
});

test("a terminal too small for the layout says how big it must be", () => {
	const out = draw(snap([main]), initialView("shop"), 60, 12);
	expect(out).toContain("needs 72×16; this terminal is 60×12");
});

test("at 100 columns an app's whole URL still shows: the state word gives way, its glyph stays", () => {
	const ns = "shop.worktree-1";
	const wide = worktree(1, { apps: [app(ns, "worker"), app(ns, "web")] });
	const out = draw(snap([main, wide]), initialView(ns), 100, 30);
	expect(out).toMatch(/● worker +https:\/\/worker\.worktree-1\.shop\.localhost:7443/);
	expect(out).not.toMatch(/localhost:744…/);
});

test("scrolled back, the stream holds still at its line and says how many newer lines wait", () => {
	const web = lines("shop/web", ...Array.from({ length: 100 }, (_, i) => `line ${i}`));
	const until = (web[1][50] as LogLine).seq;
	const out = draw(snap([main], [web]), { ...initialView("shop"), until });
	expect(out).toMatch(/line 50 +│\n.*╰/);
	expect(out).not.toContain("line 51");
	expect(out).toMatch(/LOGS +all +⏸ paused · 49 newer · end for live/);
	expect(out).toMatch(/PgUp PgDn +scroll/);
});

test("a search being typed shows in the stream's title; a found one marks its line", () => {
	const web = lines("shop/web", "GET / 200", "TypeError: boom", "GET /cart 200", "GET / 200");
	const typing = draw(snap([main], [web]), {
		...initialView("shop"),
		search: { query: "typeerr", typing: true },
	});
	expect(typing).toMatch(/LOGS +all +\/ typeerr▏ +enter find · esc cancel/);
	const until = (web[1][1] as LogLine).seq;
	const found = draw(snap([main], [web]), {
		...initialView("shop"),
		until,
		search: { query: "typeerr", typing: false },
	});
	// Found near the top, the page still fills with the lines after it.
	expect(found).toMatch(/10:00:00 › ▎web +TypeError: boom +│\n.*GET \/cart 200/);
	expect(found).toContain("0 newer");
	expect(found).toMatch(/“typeerr” +n older · N newer/);
	expect(found).toMatch(/\/ +search/);
	expect(found).toMatch(/n N +next match/);
});

test("side by side: a column for each app with its own lines, and services left out", () => {
	const logs = [
		lines("shop/web", "GET / 200", "GET /cart 200"),
		lines("shop/api", "POST /orders 201"),
		lines("shop/db", "checkpoint complete"),
	];
	const out = draw(snap([main], logs), { ...initialView("shop"), sideBySide: true });
	expect(out).toMatch(/LOGS +side by side/);
	expect(out).toMatch(/■ web +│ ■ api/);
	expect(out).toMatch(/10:00:00 GET \/ 200 +│ 10:00:00 POST \/orders 201/);
	expect(out).toMatch(/10:00:00 GET \/cart 200 +│/);
	expect(out).not.toContain("checkpoint");
	expect(out).toMatch(/v +side by side/);
});

test("a removal waiting for its word names the worktree, what goes and what stays, and the one key that goes on", () => {
	const out = draw(snap([main, worktree(1)]), {
		...initialView("shop.worktree-1"),
		confirm: { namespace: "shop.worktree-1", suffix: "worktree-1", step: "remove" },
	});
	expect(out).toMatch(
		/Remove worktree worktree-1\? Its apps, databases and git worktree go; its branch stays\. +y remove · any other key keeps it/,
	);
});

test("uncommitted changes: the second word says they are lost and shows the name as it is typed", () => {
	const out = draw(snap([main, worktree(1, { changes: true })]), {
		...initialView("shop.worktree-1"),
		confirm: { namespace: "shop.worktree-1", suffix: "worktree-1", step: "discard", typed: "work" },
	});
	expect(out).toMatch(
		/worktree-1 has uncommitted changes, which removing it loses\. Type worktree-1 and enter to remove it anyway: work▏ +esc keeps it/,
	);
});

test("a worktree being added or removed shows its progress above the keys; the one being removed says so in the sidebar", () => {
	const out = draw({
		...snap([main, worktree(1)]),
		work: [
			{ kind: "add", title: "Adding a worktree", line: "Running `npm install`" },
			{ kind: "remove", title: "Removing worktree-1", namespace: "shop.worktree-1" },
		],
	});
	expect(out).toMatch(/◐ Adding a worktree +Running `npm install`\n.*◐ Removing worktree-1\n/);
	expect(out).toMatch(/● worktree-1[^\n]*\n[^\n]*feature\/thing-1[^\n]*\n[^\n]*being removed/);
});

/** Every frame size the tests draw: the minimum, split panes, a laptop and a large screen. */
const SIZES = [
	[72, 16],
	[80, 24],
	[100, 30],
	[72, 40],
	[200, 18],
	[140, 40],
	[220, 60],
] as const;

test("at every size from the minimum up, the frame fills the terminal exactly, every key shows, and no address is cut", () => {
	const ns = "shop.worktree-1";
	const busy = {
		...snap(
			[main, worktree(1), worktree(2)],
			[lines(`${ns}/web`, ...Array.from({ length: 50 }, (_, i) => `GET /${i} 200`))],
		),
		work: [{ kind: "add" as const, title: "Adding a worktree", line: "Running `npm install`" }],
	};
	for (const [cols, rows] of SIZES) {
		const out = draw(busy, { ...initialView(ns), notice: "Restarting web…" }, cols, rows);
		const at = `${cols}×${rows}`;
		expect(out.split("\n"), at).toHaveLength(rows);
		for (const row of out.split("\n")) expect([...row].length, at).toBeLessThanOrEqual(cols);
		for (const key of ["environment", "start", "add worktree", "remove worktree", "close"])
			expect(out, at).toContain(key);
		expect(out, at).toContain("Adding a worktree");
		expect(out, at).toContain("Restarting web…");
		expect(out, at).toMatch(/▌● worktree-1/);
		expect(out, at).toMatch(/GET \/49 200/);
		// The selected part with its whole address, wrapped where it must be: the database's too.
		const db = draw(busy, { ...initialView(ns), focus: "shop/db" }, cols, rows);
		for (const [view, address] of [
			[out, "https://web.worktree-1.shop.localhost:7443"],
			[db, "postgresql://postgres@127.0.0.1:15432/shop_worktree_1"],
		] as const) {
			const right = view
				.split("\n")
				.map((row) => row.split("│")[3]?.trim() ?? "")
				.join("");
			expect(right, at).toContain(address);
			expect(view, at).not.toMatch(/localhost:74…|127\.0\.0…|shop_work…/);
		}
	}
});

test("on a short terminal, the selected environment stays in view however many there are, and the sidebar says how many more", () => {
	const many = [main, ...Array.from({ length: 9 }, (_, i) => worktree(i + 1))];
	const last = draw(snap(many), initialView("shop.worktree-9"), 100, 20);
	expect(last).toMatch(/▌● worktree-9/);
	expect(last).toMatch(/↑ \d+ more/);
	expect(last).not.toMatch(/● main/);
	const first = draw(snap(many), initialView("shop"), 100, 20);
	expect(first).toMatch(/▌● main/);
	expect(first).toMatch(/↓ \d+ more/);
	const middle = draw(snap(many), initialView("shop.worktree-5"), 100, 20);
	expect(middle).toMatch(/↑ \d+ more[\s\S]*▌● worktree-5[\s\S]*↓ \d+ more/);
});

test("many failed apps on a short terminal: the alerts give way to one line that counts the rest", () => {
	const failed = (n: number) =>
		worktree(n, {
			apps: [app(`shop.worktree-${n}`, "web", { state: "failed", error: "exit code 1" })],
		});
	const out = draw(
		snap([main, failed(1), failed(2), failed(3), failed(4)]),
		initialView("shop"),
		80,
		18,
	);
	expect(out).toMatch(/✖ worktree-1 › web exited \(exit code 1\).*\+3 more failed/);
	expect(out).not.toMatch(/worktree-2 › web/);
	expect(out.split("\n")).toHaveLength(18);
});

test("the frame resized keeps the view: the same selection, focus and pause at each size", () => {
	const web = lines("shop/web", ...Array.from({ length: 100 }, (_, i) => `line ${i}`));
	const until = (web[1][50] as LogLine).seq;
	const view = { ...initialView("shop"), focus: "shop/web", until };
	for (const [cols, rows] of SIZES) {
		const out = draw(snap([main], [web]), view, cols, rows);
		expect(out, `${cols}×${rows}`).toMatch(/line 50 +│\n.*╰/);
		expect(out, `${cols}×${rows}`).toMatch(/› ● web/);
		expect(out, `${cols}×${rows}`).toContain("paused");
	}
});

// ── colour ────────────────────────────────────────────────────────────────────────────────

const level = chalk.level;
afterEach(() => {
	chalk.level = level;
});

/** The SGR codes a frame uses, each once. */
const codes = (text: string) =>
	new Set(
		text
			.split("\u001b[")
			.slice(1)
			.map((rest) => rest.slice(0, rest.indexOf("m"))),
	);

const colourful = () =>
	snap(
		[
			{
				...main,
				apps: [
					app("shop", "web"),
					app("shop", "api", { state: "failed", error: "exit code 1" }),
					app("shop", "worker", { state: "starting" }),
				],
			},
			worktree(1, { apps: [app("shop.worktree-1", "web", { state: "idle" })] }),
		],
		[lines("shop/web", "GET / 200", "WARN slow")],
	);

test("NO_COLOR: not one colour, though the terminal has them all; glyphs and words say each state", () => {
	chalk.level = 3;
	const out = draw(colourful(), initialView("shop"), 140, 40, "none");
	for (const code of codes(out)) expect(code).not.toMatch(/^(3|4|9|10)\d|38;|48;/);
	const plain = stripVTControlCharacters(out);
	expect(plain).toMatch(/● web +running/);
	expect(plain).toMatch(/✖ api +failed/);
	expect(plain).toMatch(/◐ worker +starting/);
});

test("16 colours: the terminal's own named colours, a different one for running, starting and failed", () => {
	chalk.level = 1;
	const out = renderToString(
		frame({
			snapshot: colourful(),
			view: initialView("shop"),
			cols: 140,
			rows: 40,
			now: "10:00:05",
			color: "16",
		}),
		{ columns: 140 },
	);
	for (const code of codes(out)) expect(code).not.toMatch(/38;|48;/);
	expect(out).toContain("\u001b[32m● ");
	expect(out).toContain("\u001b[33m◐ ");
	expect(out).toContain("\u001b[31m✖ ");
	// The panels' borders are not black, which a dark terminal would hide.
	expect(out).not.toContain("\u001b[30m╭");
});

test("256 colours and true colour: the palette, which chalk fits to the terminal", () => {
	chalk.level = 3;
	const truecolor = draw(colourful(), initialView("shop"), 140, 40, "rgb");
	expect(truecolor).toContain("\u001b[38;2;158;206;106m● ");
	chalk.level = 2;
	expect(draw(colourful(), initialView("shop"), 140, 40, "rgb")).toContain("\u001b[38;5;150m● ");
});

test("which colours: NO_COLOR set to anything turns them off; else as many as the terminal has", () => {
	expect(colorsFor("1", 3)).toBe("none");
	expect(colorsFor("", 3)).toBe("rgb");
	expect(colorsFor(undefined, 3)).toBe("rgb");
	expect(colorsFor(undefined, 2)).toBe("rgb");
	expect(colorsFor(undefined, 1)).toBe("16");
	expect(colorsFor(undefined, 0)).toBe("none");
});
