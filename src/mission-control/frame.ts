import { Box, Text } from "ink";
import { createElement as h, type ReactElement, type ReactNode } from "react";
import {
	type EnvironmentView,
	type LogLine,
	type Part,
	type PartState,
	partsOf,
	type Snapshot,
	selectedOf,
	streamLines,
	type View,
} from "./model.ts";

/**
 * Mission control's frame: a pure function from the snapshot, the view and the terminal's size to
 * one screen, as an Ink element. Layout A: environments down the left; the selected one's apps and
 * services top right; one merged, colour-coded log stream below. A header with counts above, an
 * alert line for each failed app anywhere, and the keys below. No hooks, so `renderToString` draws
 * it exactly as the live view does.
 */
export interface FrameInput {
	snapshot: Snapshot;
	view: View;
	cols: number;
	rows: number;
	/** The clock, `HH:MM:SS`. */
	now: string;
	/** Whether to colour it; off for `NO_COLOR`. Meaning never rests on colour alone. */
	color: boolean;
}

/** The smallest terminal the layout fits; below it the frame asks for more room. */
export const MIN_COLS = 72;
export const MIN_ROWS = 16;

export function frame({ snapshot, view, cols, rows, now, color }: FrameInput): ReactElement {
	const c = palette(color);
	if (cols < MIN_COLS || rows < MIN_ROWS) {
		return centred(
			cols,
			rows,
			c.mute,
			`Mission control needs ${MIN_COLS}×${MIN_ROWS}; this terminal is ${cols}×${rows}. Enlarge it, or press q.`,
		);
	}
	const env = selectedOf(snapshot, view);
	if (env === undefined) return centred(cols, rows, c.mute, "Reading the supervisor…");
	const alerts = alertLines(snapshot, cols, c);
	const keys = footer(cols, c);
	const { body, side, right, table } = sizes(snapshot, env, cols, rows);
	return h(
		Box,
		{ flexDirection: "column", width: cols, height: rows },
		header(snapshot, cols, now, c),
		gap("g1"),
		...alerts,
		alerts.length > 0 ? gap("g2") : null,
		h(
			Box,
			{ key: "body", flexDirection: "row", height: body },
			sidebar(snapshot, view, env, side, body, c),
			gap("g3"),
			h(
				Box,
				{ flexDirection: "column", width: right },
				partsPanel(env, view, snapshot, right, table, c),
				stream(env, view, snapshot, right, body - table, c),
			),
		),
		view.notice === undefined
			? gap("g4")
			: line("notice", cols, [run(" "), run(view.notice, c.accent)]),
		...keys,
	);
}

/** Where the frame's pieces go: the body's height, the two columns' widths, the parts' height. */
function sizes(snapshot: Snapshot, env: EnvironmentView, cols: number, rows: number) {
	const failed = snapshot.environments.flatMap((e) => e.apps).filter((a) => a.state === "failed");
	const keys = footer(cols, COLORS).length;
	const body = rows - 3 - keys - failed.length - (failed.length > 0 ? 1 : 0);
	const side = Math.min(34, Math.max(24, Math.floor(cols * 0.2)));
	const right = cols - side - 1;
	const wanted = partsHeight(env);
	// The stream keeps at least a third of the body, so a long parts list never hides the logs.
	const table = Math.min(wanted, Math.max(6, body - Math.max(6, Math.floor(body / 3))));
	return { body, side, right, table };
}

/** How many log lines the stream shows: what a page up or down moves by. */
export function pageOf(snapshot: Snapshot, view: View, cols: number, rows: number): number {
	const env = selectedOf(snapshot, view);
	if (env === undefined || cols < MIN_COLS || rows < MIN_ROWS) return 10;
	const { body, table } = sizes(snapshot, env, cols, rows);
	return Math.max(1, body - table - 2);
}

// ── colour ────────────────────────────────────────────────────────────────────────────────────

type Color = string | undefined;
interface Palette {
	frame: Color;
	focus: Color;
	text: Color;
	soft: Color;
	mute: Color;
	dim: Color;
	ok: Color;
	warn: Color;
	bad: Color;
	accent: Color;
	keyBg: Color;
	/** Each part's own colour, never red, amber or green, so its lines are found in a merged stream. */
	parts: Color[];
}

/**
 * Colour carries meaning: green runs, amber is on its way or warns, red failed, grey is idle.
 * Without colour every one is undefined, and glyphs and words carry the meaning.
 */
const COLORS: Palette = {
	frame: "#2f344d",
	focus: "#7aa2f7",
	text: "#c0caf5",
	soft: "#a9b1d6",
	mute: "#737aa2",
	dim: "#565f89",
	ok: "#9ece6a",
	warn: "#e0af68",
	bad: "#f7768e",
	accent: "#7aa2f7",
	keyBg: "#283457",
	parts: ["#7aa2f7", "#bb9af7", "#7dcfff", "#ff9e64", "#c3a6ff", "#73daca"],
};

function palette(on: boolean): Palette {
	if (on) return COLORS;
	const none = Object.fromEntries(Object.keys(COLORS).map((key) => [key, undefined]));
	return { ...(none as unknown as Palette), parts: [undefined] };
}

const STATES: Record<
	PartState,
	{ glyph: string; word: string; tone: "ok" | "warn" | "bad" | "dim" }
> = {
	running: { glyph: "●", word: "running", tone: "ok" },
	starting: { glyph: "◐", word: "starting", tone: "warn" },
	failed: { glyph: "✖", word: "failed", tone: "bad" },
	stopped: { glyph: "■", word: "stopped", tone: "dim" },
	idle: { glyph: "○", word: "idle", tone: "dim" },
};

function partColor(env: EnvironmentView, id: string, c: Palette): string | undefined {
	const i = partsOf(env).findIndex((part) => part.id === id);
	return c.parts[Math.max(0, i) % c.parts.length];
}

// ── text runs ─────────────────────────────────────────────────────────────────────────────────

/** A piece of a row: its text and how it is drawn. */
interface Run {
	text: string;
	color?: string | undefined;
	bg?: string | undefined;
	bold?: boolean;
}

const run = (text: string, color?: string, more: Omit<Run, "text" | "color"> = {}): Run => ({
	text,
	color,
	...more,
});

const widthOf = (runs: Run[]) => runs.reduce((n, r) => n + [...r.text].length, 0);

/** One row of runs, cut at `width` with `…`: only log lines and chrome are ever cut, never names. */
function line(key: string, width: number, runs: Run[]): ReactElement {
	return h(
		Box,
		{ key, width, height: 1, overflow: "hidden", flexShrink: 0 },
		h(
			Text,
			{ wrap: "truncate-end" },
			...runs.map((r, i) =>
				h(Text, { key: i, color: r.color, backgroundColor: r.bg, bold: r.bold }, r.text),
			),
		),
	);
}

const gap = (key: string) => h(Box, { key, height: 1, width: 1, flexShrink: 0 });

/** `text` padded to `n` columns; longer text is kept whole. */
const pad = (text: string, n: number) => text + " ".repeat(Math.max(0, n - [...text].length));

/**
 * `text` in pieces of at most `width` columns, so a long name wraps instead of being cut: after a
 * `/`, `-` or space where one is near the end of a piece, else at the width.
 */
function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	let rest = [...text];
	while (rest.length > width) {
		const piece = rest.slice(0, width);
		const soft = Math.max(piece.lastIndexOf("/"), piece.lastIndexOf("-"), piece.lastIndexOf(" "));
		const cut = soft >= width / 2 ? soft + 1 : width;
		out.push(rest.slice(0, cut).join(""));
		rest = rest.slice(cut);
	}
	out.push(rest.join(""));
	return out;
}

function centred(cols: number, rows: number, color: string | undefined, text: string) {
	return h(
		Box,
		{ width: cols, height: rows, alignItems: "center", justifyContent: "center" },
		h(Box, { width: Math.min(cols - 4, 60) }, h(Text, { color }, text)),
	);
}

/**
 * A rounded panel with its title set in the top border, `╭─ title ──── right ─╮`: Ink draws no
 * titles, so the top line is drawn here. Its content gets `width - 4` columns, `height - 2` rows.
 */
function panel(
	key: string,
	width: number,
	height: number,
	border: string | undefined,
	title: Run[],
	right: Run[],
	children: ReactNode[],
): ReactElement {
	const t = title.length > 0 ? [run(" "), ...title, run(" ")] : [];
	let r = right.length > 0 ? [run(" "), ...right, run(" ")] : [];
	if (widthOf(t) + widthOf(r) > width - 4) r = [];
	const fill = Math.max(0, width - 4 - widthOf(t) - widthOf(r));
	const top = [run("╭─", border), ...t, run("─".repeat(fill), border), ...r, run("─╮", border)];
	return h(
		Box,
		{ key, flexDirection: "column", width, height, flexShrink: 0 },
		line("top", width, top),
		h(
			Box,
			{
				borderStyle: "round",
				borderTop: false,
				borderColor: border,
				width,
				height: height - 1,
				paddingX: 1,
				flexDirection: "column",
				overflow: "hidden",
			},
			...children,
		),
	);
}

// ── what the snapshot says ────────────────────────────────────────────────────────────────────

/** An environment's state at a glance: failed beats starting beats running; none running is idle. */
function rollup(env: EnvironmentView): { state: PartState | "problem"; note: string } {
	if (env.problem !== undefined) return { state: "problem", note: "config does not load" };
	const { apps } = env;
	const failed = apps.filter((a) => a.state === "failed");
	if (failed.length > 0)
		return { state: "failed", note: `${failed.map((a) => a.name).join(", ")} failed` };
	if (apps.some((a) => a.state === "starting")) return { state: "starting", note: "starting" };
	const running = apps.filter((a) => a.state === "running").length;
	if (apps.length === 0) return { state: "idle", note: "no apps" };
	if (running > 0) return { state: "running", note: `${running}/${apps.length} apps running` };
	if (apps.some((a) => a.state === "idle")) return { state: "idle", note: "idle until opened" };
	return { state: "stopped", note: "stopped" };
}

function lookOf(state: PartState | "problem", c: Palette) {
	if (state === "problem") return { glyph: "▲", word: "problem", color: c.warn };
	const s = STATES[state];
	return { glyph: s.glyph, word: s.word, color: c[s.tone] };
}

/** How a log line reads: an error, a warning, or plain. */
function tone(text: string, c: Palette): string | undefined {
	if (/\b(ERROR|FATAL|PANIC)\b|Error\b|^\s+at |exception|^Node\.js v/.test(text)) return c.bad;
	if (/\bWARN(ING)?\b/.test(text)) return c.warn;
	return c.text;
}

/** A line without the date, zone and pid a server stamps on it itself (Postgres does). */
const clean = (text: string) =>
	text.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)? \w+ (\[\d+\] )?/, "");

/** A failed part's last line that names its error. */
function lastError(lines: readonly LogLine[] = []): string {
	for (let i = lines.length - 1; i >= 0; i--) {
		const text = (lines[i] as LogLine).text;
		if (/Error\b|ERROR|FATAL/.test(text)) return text.trim();
	}
	return "";
}

/** The newest `n` lines of the given parts, merged in arrival order. */
function merged(logs: Snapshot["logs"], ids: string[], n: number): LogLine[] {
	const all: LogLine[] = [];
	for (const id of ids) all.push(...(logs.get(id) ?? []).slice(-n));
	return all.sort((a, b) => a.seq - b.seq).slice(-n);
}

// ── the pieces ────────────────────────────────────────────────────────────────────────────────

function header(snapshot: Snapshot, cols: number, now: string, c: Palette): ReactElement {
	const apps = snapshot.environments.flatMap((env) => env.apps);
	const count = (state: PartState) => apps.filter((a) => a.state === state).length;
	const wide = cols >= 120;
	const failed = count("failed");
	const left = [
		run(" ◉ ", c.accent, { bold: true }),
		run("basepad", c.text, { bold: true }),
		run(wide ? "  mission control" : "", c.mute),
		run("   "),
		run(snapshot.project, c.accent, { bold: true }),
	];
	const envs = snapshot.environments.length;
	const right = [
		run(wide ? `${envs} environment${envs === 1 ? "" : "s"}   ` : "", c.mute),
		run("● ", c.ok),
		run(`${count("running")} running   `, c.soft),
		...(failed > 0 ? [run("✖ ", c.bad), run(`${failed} failed   `, c.bad, { bold: true })] : []),
		run("○ ", c.dim),
		run(`${count("idle")} idle   `, c.soft),
		run("⇣ ", c.mute),
		run(`${snapshot.rate}${wide ? " lines/s" : "/s"}   `, c.soft),
		run(now, c.text, { bold: true }),
		run(" "),
	];
	const fill = Math.max(1, cols - widthOf(left) - widthOf(right));
	return line("header", cols, [...left, run(" ".repeat(fill)), ...right]);
}

/** A line for each failed app in any environment, so a crash is seen whatever is selected. */
function alertLines(snapshot: Snapshot, cols: number, c: Palette): ReactElement[] {
	return snapshot.environments.flatMap((env) =>
		env.apps
			.filter((a) => a.state === "failed")
			.map((a) => {
				const why = lastError(snapshot.logs.get(a.id));
				return line(`alert ${a.id}`, cols, [
					run(" ✖ ", c.bad, { bold: true }),
					run(`${env.label} › ${a.name}`, c.bad, { bold: true }),
					run(` exited (${a.error ?? "failed"})`, c.bad),
					run(why === "" ? "" : `  ${why}`, c.soft),
				]);
			}),
	);
}

/** Every key with what it does, as many to a row as fit. */
const KEYS: [string, string][] = [
	["↑↓", "environment"],
	["←→", "app or service"],
	["esc", "all logs"],
	["PgUp PgDn", "scroll"],
	["s", "start"],
	["x", "stop"],
	["r", "restart"],
	["o", "open"],
	["c", "copy"],
	["q", "close"],
];

/** The keys, in rows: each key's label stays with its key. */
function footer(cols: number, c: Palette): ReactElement[] {
	const rows: Run[][] = [[run(" ")]];
	for (const [k, label] of KEYS) {
		const item = [run(` ${k} `, c.text, { bg: c.keyBg, bold: true }), run(` ${label}   `, c.mute)];
		let last = rows[rows.length - 1] as Run[];
		if (widthOf(last) + widthOf(item) - 3 > cols && last.length > 1) {
			last = [run(" ")];
			rows.push(last);
		}
		last.push(...item);
	}
	const last = rows[rows.length - 1] as Run[];
	const tail = run("·  everything keeps running", c.dim);
	if (widthOf(last) + widthOf([tail]) <= cols) last.push(tail);
	return rows.map((runs, i) => line(`keys ${i}`, cols, runs));
}

/** Environments down the left: state glyph and name, the branch whole, the state in words. */
function sidebar(
	snapshot: Snapshot,
	view: View,
	selected: EnvironmentView,
	width: number,
	height: number,
	c: Palette,
): ReactElement {
	const inner = width - 4;
	const rows: ReactElement[] = [];
	for (const env of snapshot.environments) {
		const on = env === selected;
		const s = rollup(env);
		const look = lookOf(s.state, c);
		const bar = on ? run("▌", c.accent) : run(" ");
		const k = env.namespace;
		rows.push(
			line(`${k} name`, inner, [
				bar,
				run(`${look.glyph} `, look.color),
				run(env.label, on ? c.text : c.soft, { bold: on }),
			]),
		);
		wrap(env.branch ?? "(detached)", inner - 3).forEach((piece, i) => {
			rows.push(
				line(`${k} branch ${i}`, inner, [bar, run("  "), run(piece, on ? c.soft : c.mute)]),
			);
		});
		rows.push(
			line(`${k} note`, inner, [
				bar,
				run("  "),
				run(s.note, s.state === "running" ? c.mute : look.color),
			]),
		);
		rows.push(gap(`${k} gap`));
	}
	void view;
	return panel(
		"sidebar",
		width,
		height,
		c.frame,
		[run("ENVIRONMENTS", c.mute, { bold: true })],
		[],
		rows,
	);
}

/** The panel's height for an environment's parts: a row each, headings, a gap, its border. */
function partsHeight(env: EnvironmentView): number {
	if (env.problem !== undefined) return 6;
	const groups = (env.apps.length > 0 ? 1 : 0) + (env.services.length > 0 ? 1 : 0);
	return 2 + env.apps.length + env.services.length + groups + Math.max(0, groups - 1) || 3;
}

/** The selected environment's apps and services: state, address, and a detail. */
function partsPanel(
	env: EnvironmentView,
	view: View,
	snapshot: Snapshot,
	width: number,
	height: number,
	c: Palette,
): ReactElement {
	const inner = width - 4;
	const rows: ReactElement[] = [];
	const nameWidth = Math.max(8, ...partsOf(env).map((p) => [...p.name].length)) + 2;
	// Narrow, the state word gives way so an address fits whole; the glyph still says the state.
	const words = inner >= 96;
	const heading = (key: string, text: string) =>
		line(key, inner, [run(text, c.dim, { bold: true })]);
	const row = (part: Part, isApp: boolean) => {
		const look = lookOf(part.state, c);
		const on = view.focus === part.id;
		const detail =
			part.state === "failed"
				? [
						run(`${part.error ?? "exited"}`, c.bad),
						run(`  ${lastError(snapshot.logs.get(part.id))}`, c.soft),
					]
				: part.state === "idle"
					? [run(part.address, c.soft), run("   starts on its first request", c.dim)]
					: [
							run(part.address, part.state === "running" ? c.text : c.soft),
							run(part.note === undefined ? "" : `   ${part.note}`, c.dim),
						];
		void isApp;
		return line(part.id, inner, [
			run(on ? "› " : "  ", c.accent, { bold: true }),
			run(`${look.glyph} `, look.color),
			run(pad(part.name, nameWidth), partColor(env, part.id, c), { bold: true }),
			...(words ? [run(pad(look.word, 10), look.color)] : []),
			...detail,
		]);
	};
	if (env.problem !== undefined) {
		for (const [i, piece] of wrap(env.problem, inner)
			.slice(0, height - 2)
			.entries()) {
			rows.push(line(`problem ${i}`, inner, [run(piece, c.warn)]));
		}
	} else if (partsOf(env).length === 0) {
		rows.push(line("none", inner, [run("No apps or services in its config.", c.mute)]));
	} else {
		if (env.apps.length > 0) {
			rows.push(heading("apps", "APPS"));
			for (const part of env.apps) rows.push(row(part, true));
		}
		if (env.services.length > 0) {
			if (env.apps.length > 0) rows.push(gap("services gap"));
			rows.push(heading("services", "SERVICES"));
			for (const part of env.services) rows.push(row(part, false));
		}
	}
	return panel(
		"parts",
		width,
		height,
		c.frame,
		[run(env.label, c.text, { bold: true }), run(`  · ${env.branch ?? "(detached)"}`, c.soft)],
		[run(env.dir, c.dim)],
		rows,
	);
}

/** One merged, colour-coded stream of the environment's parts, or of the focused one alone. */
function stream(
	env: EnvironmentView,
	view: View,
	snapshot: Snapshot,
	width: number,
	height: number,
	c: Palette,
): ReactElement {
	const parts = partsOf(env);
	const focused = parts.find((part) => part.id === view.focus);
	const ids = focused === undefined ? parts.map((part) => part.id) : [focused.id];
	const inner = width - 4;
	const n = Math.max(0, height - 2);
	const nameWidth = Math.max(...parts.map((p) => [...p.name].length), 3) + 2;
	// Live, only the newest lines of each part are merged; paused, all of them, up to its line.
	const paused = view.until;
	const all = paused === undefined ? [] : streamLines(snapshot, view);
	const upTo = all.filter((l) => l.seq <= (paused as number));
	const shown = paused === undefined ? merged(snapshot.logs, ids, n) : upTo.slice(-n);
	const rows = shown.map((l) => {
		const color = partColor(env, l.id, c);
		const name = parts.find((part) => part.id === l.id)?.name ?? l.id;
		return line(`${l.seq}`, inner, [
			run(`${l.time}  `, c.dim),
			...(focused === undefined ? [run("▎", color), run(pad(name, nameWidth), color)] : []),
			run(clean(l.text), tone(l.text, c)),
		]);
	});
	if (rows.length === 0) {
		const idle = env.apps.length > 0 && env.apps.every((p) => p.state === "idle");
		rows.push(
			line("empty", inner, [
				run(
					idle ? "No output yet: its apps start on their first request." : "Waiting for output…",
					c.dim,
				),
			]),
		);
	}
	const legend = parts.flatMap((part, i) => [
		run(i === 0 ? "" : "  "),
		run("■ ", partColor(env, part.id, c)),
		run(part.name, focused === undefined || focused === part ? c.soft : c.dim),
	]);
	return panel(
		"stream",
		width,
		height,
		focused === undefined ? c.frame : c.focus,
		[
			run("LOGS", c.mute, { bold: true }),
			run(focused === undefined ? "  all" : `  ${focused.name} only`, focused ? c.accent : c.soft),
			...(paused === undefined
				? []
				: [
						run("  ⏸ paused", c.warn, { bold: true }),
						run(` · ${all.length - upTo.length} newer · end for live`, c.soft),
					]),
		],
		legend,
		rows,
	);
}
