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
	/** How to colour it: `none` for `NO_COLOR`; meaning never rests on colour alone. */
	color: Colors;
}

/**
 * The colours a frame is drawn in: `rgb`, the palette, which chalk fits to a terminal of 256
 * colours; `16`, the terminal's own named colours, which its theme keeps legible; or `none`.
 */
export type Colors = "none" | "16" | "rgb";

/**
 * The colours for a terminal: none when `NO_COLOR` is set to anything but empty
 * (https://no-color.org), which chalk ignores; else by chalk's colour `level` for the terminal.
 */
export function colorsFor(noColor: string | undefined, level: number): Colors {
	if (noColor !== undefined && noColor !== "") return "none";
	return level >= 2 ? "rgb" : level === 1 ? "16" : "none";
}

/** The smallest terminal the layout fits; below it the frame asks for more room. */
export const MIN_COLS = 72;
export const MIN_ROWS = 16;
/** Below this many rows the frame is compact: no blank rows, tighter keys, fewer alert lines. */
const SHORT_ROWS = 24;

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
	const { top, bottom, body, side, right, table, short } = arrange(
		snapshot,
		view,
		env,
		cols,
		rows,
		now,
		c,
	);
	return h(
		Box,
		{ flexDirection: "column", width: cols, height: rows },
		...top,
		h(
			Box,
			{ key: "body", flexDirection: "row", height: body },
			sidebar(snapshot, env, side, body, short, c),
			gap("g3"),
			h(
				Box,
				{ flexDirection: "column", width: right },
				partsPanel(env, view, snapshot, right, table, short, c),
				stream(env, view, snapshot, right, body - table, c),
			),
		),
		...bottom,
	);
}

/**
 * Where the frame's pieces go: the rows above the body (header, alerts) and below it (work under
 * way, the notice or a question, the keys), the body's height, the two columns' widths and the
 * parts panel's height.
 */
function arrange(
	snapshot: Snapshot,
	view: View,
	env: EnvironmentView,
	cols: number,
	rows: number,
	now: string,
	c: Palette,
) {
	const short = rows < SHORT_ROWS;
	const alerts = alertLines(snapshot, cols, short ? 1 : 3, c);
	const top = [
		header(snapshot, cols, now, c),
		short ? null : gap("g1"),
		...alerts,
		alerts.length > 0 && !short ? gap("g2") : null,
	].filter((e) => e !== null);
	const said = status(snapshot, view, cols, short, c);
	const bottom = [...(said.length === 0 && !short ? [gap("g4")] : said), ...footer(cols, short, c)];
	const body = rows - top.length - bottom.length;
	const side = Math.min(34, Math.max(24, Math.floor(cols * 0.2)));
	const right = cols - side - 1;
	// The stream keeps at least a third of the body, so a long parts list never hides the logs.
	const keep = Math.max(short ? 4 : 6, Math.floor(body / 3));
	const most = Math.max(short ? 3 : 6, body - keep);
	// As many rows as the parts that fit take, so none is left blank (see `partsShown`).
	const table =
		env.problem !== undefined
			? Math.min(6, most)
			: partsOf(env).length === 0
				? 3
				: Math.max(3, Math.min(most, 2 + partsShown(env, right - 4, most - 2, short, view).length));
	return { top, bottom, body, side, right, table, short };
}

/** How many log lines the stream shows: what a page up or down moves by. */
export function pageOf(snapshot: Snapshot, view: View, cols: number, rows: number): number {
	const env = selectedOf(snapshot, view);
	if (env === undefined || cols < MIN_COLS || rows < MIN_ROWS) return 10;
	const { body, table } = arrange(snapshot, view, env, cols, rows, "", palette("none"));
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
	parts: ["#7aa2f7", "#bb9af7", "#7dcfff", "#ff9e64", "#9d7cd8", "#73daca"],
};

/**
 * The terminal's own named colours, for one of 16: its theme sets them, so each is legible on its
 * background, dark or light. Text keeps the terminal's own foreground.
 */
const NAMED: Palette = {
	frame: "gray",
	focus: "cyan",
	text: undefined,
	soft: undefined,
	mute: "gray",
	dim: "gray",
	ok: "green",
	warn: "yellow",
	bad: "red",
	accent: "cyan",
	keyBg: "gray",
	parts: ["blueBright", "magenta", "cyan", "magentaBright", "cyanBright", "blue"],
};

function palette(colors: Colors): Palette {
	if (colors === "rgb") return COLORS;
	if (colors === "16") return NAMED;
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
	/** Drawn in reverse: a search's matches, which needs no colour. */
	inverse?: boolean;
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
				h(
					Text,
					{ key: i, color: r.color, backgroundColor: r.bg, bold: r.bold, inverse: r.inverse },
					r.text,
				),
			),
		),
	);
}

const gap = (key: string) => h(Box, { key, height: 1, width: 1, flexShrink: 0 });

/** `text` padded to `n` columns; longer text is kept whole. */
const pad = (text: string, n: number) => text + " ".repeat(Math.max(0, n - [...text].length));

/**
 * `text` in pieces of at most `width` columns, so a long name wraps instead of being cut: after a
 * `/`, `-`, `.` or space where one is near the end of a piece, else at the width.
 */
function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	let rest = [...text];
	while (rest.length > width) {
		const piece = rest.slice(0, width);
		const soft = Math.max(...["/", "-", " ", "."].map((c) => piece.lastIndexOf(c)));
		const cut = soft >= width / 2 ? soft + 1 : width;
		out.push(rest.slice(0, cut).join(""));
		rest = rest.slice(cut);
	}
	out.push(rest.join(""));
	return out;
}

/**
 * `runs` in rows of at most `width` columns, broken between words, so a question or a notice is
 * read whole rather than cut. A word longer than a row is broken within it.
 */
function flow(runs: Run[], width: number): Run[][] {
	const rows: Run[][] = [[]];
	let used = 0;
	for (const r of runs) {
		for (const word of r.text.split(/(?<= )/)) {
			let rest = [...word];
			while (rest.length > 0) {
				const room = width - used;
				const fits = rest.length <= room || rest.join("").trimEnd().length <= room;
				if (!fits && used > 0) {
					rows.push([]);
					used = 0;
					continue;
				}
				const piece = fits ? rest : rest.slice(0, room);
				(rows[rows.length - 1] as Run[]).push({ ...r, text: piece.join("") });
				used += piece.length;
				rest = rest.slice(piece.length);
			}
		}
	}
	return rows;
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
	// The title is cut inside the border, so its corner always draws.
	const t = title.length > 0 ? clip([run(" "), ...title, run(" ")], width - 4) : [];
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

/** How far back a failed part's output is searched for the line that names its error. */
const LAST_OUTPUT = 20;

/**
 * A failed part's last output: of its last lines, the newest that names an error, else its last
 * line that is not blank, whatever it says. Empty only when it printed nothing.
 */
function lastError(lines: readonly LogLine[] = []): string {
	const recent = lines
		.slice(-LAST_OUTPUT)
		.map((l) => l.text.trim())
		.filter((text) => text !== "");
	return recent.findLast((text) => /Error\b|ERROR|FATAL/.test(text)) ?? recent.at(-1) ?? "";
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

/**
 * A line for each failed app in any environment, so a crash is seen whatever is selected: at most
 * `most`, the last of which counts the rest.
 */
function alertLines(snapshot: Snapshot, cols: number, most: number, c: Palette): ReactElement[] {
	const failed = snapshot.environments.flatMap((env) =>
		env.apps.filter((a) => a.state === "failed").map((a) => ({ env, a })),
	);
	const shown = failed.length > most ? failed.slice(0, most) : failed;
	return shown.map(({ env, a }, i) => {
		const why = lastError(snapshot.logs.get(a.id));
		const more = i === shown.length - 1 ? failed.length - shown.length : 0;
		return line(`alert ${a.id}`, cols, [
			run(" ✖ ", c.bad, { bold: true }),
			run(`${env.label} › ${a.name}`, c.bad, { bold: true }),
			run(` exited (${a.error ?? "failed"})`, c.bad),
			run(more > 0 ? `  +${more} more failed` : "", c.bad, { bold: true }),
			run(why === "" ? "" : `  ${why}`, c.soft),
		]);
	});
}

/**
 * The rows above the keys: each worktree being added or removed with its command's last line, then
 * a removal's question, or what the last key did. Questions and notices wrap rather than cut.
 */
function status(
	snapshot: Snapshot,
	view: View,
	cols: number,
	short: boolean,
	c: Palette,
): ReactElement[] {
	const work = (snapshot.work ?? [])
		.slice(0, short ? 1 : 2)
		.map((w, i) =>
			line(`work ${i}`, cols, [
				run(" ◐ ", c.warn, { bold: true }),
				run(w.title, c.warn, { bold: true }),
				run(w.line === undefined ? "" : `  ${w.line}`, c.soft),
			]),
		);
	const { confirm } = view;
	let said: Run[] = [];
	if (confirm?.step === "remove") {
		said = [
			run("Remove worktree ", c.text, { bold: true }),
			run(confirm.suffix, c.bad, { bold: true }),
			run("? Its apps, databases and git worktree go; its branch stays.  ", c.text),
			run("y", c.bad, { bold: true }),
			// Kept together, so a row never starts with a lone "it".
			run(" remove · any other key keeps\u00a0it", c.mute),
		];
	} else if (confirm?.step === "discard") {
		said = [
			run(confirm.suffix, c.bad, { bold: true }),
			run(" has uncommitted changes, which removing it loses. ", c.bad, { bold: true }),
			run("Type ", c.text),
			run(confirm.suffix, c.text, { bold: true }),
			run(" and enter to remove it anyway: ", c.text),
			run(`${confirm.typed ?? ""}▏`, c.text, { bold: true }),
			run("  esc\u00a0keeps\u00a0it", c.mute),
		];
	} else if (view.notice !== undefined) {
		said = [run(view.notice, c.accent)];
	}
	const rows = said.length === 0 ? [] : flow(said, cols - 2).slice(0, short ? 2 : 3);
	return [...work, ...rows.map((runs, i) => line(`said ${i}`, cols, [run(" "), ...runs]))];
}

/** Every key with what it does, as many to a row as fit. */
const KEYS: [string, string][] = [
	["↑↓", "environment"],
	["←→", "app or service"],
	["s", "start"],
	["x", "stop"],
	["r", "restart"],
	["o", "open"],
	["c", "copy"],
	["a", "add worktree"],
	["d", "remove worktree"],
	["v", "side by side"],
	["/", "search"],
	["n N", "next match"],
	["PgUp PgDn", "scroll"],
	["esc", "back"],
	["q", "close"],
];

/** The keys, in rows: each key's label stays with its key. Short, they sit closer together. */
function footer(cols: number, short: boolean, c: Palette): ReactElement[] {
	const rows: Run[][] = [[run(" ")]];
	const space = short ? "  " : "   ";
	for (const [k, label] of KEYS) {
		const key = short ? k : ` ${k} `;
		const item = [run(key, c.text, { bg: c.keyBg, bold: true }), run(` ${label}${space}`, c.mute)];
		let last = rows[rows.length - 1] as Run[];
		if (widthOf(last) + widthOf(item) - space.length >= cols && last.length > 1) {
			last = [run(" ")];
			rows.push(last);
		}
		last.push(...item);
	}
	const last = rows[rows.length - 1] as Run[];
	const tail = run("·  everything keeps running", c.dim);
	if (widthOf(last) + widthOf([tail]) <= cols) last.push(tail);
	// A row's trailing gap would push it past the edge and cut it with `…`.
	return rows.map((runs, i) => {
		const end = runs[runs.length - 1] as Run;
		const trimmed = [...runs.slice(0, -1), { ...end, text: end.text.trimEnd() }];
		return line(`keys ${i}`, cols, trimmed);
	});
}

/**
 * Environments down the left: state glyph and name, the branch whole, the state in words. When
 * they do not all fit, a window of them that holds the selected one, with how many more above and
 * below.
 */
function sidebar(
	snapshot: Snapshot,
	selected: EnvironmentView,
	width: number,
	height: number,
	short: boolean,
	c: Palette,
): ReactElement {
	const inner = width - 4;
	const removing = new Set((snapshot.work ?? []).map((w) => w.namespace));
	const blocks = snapshot.environments.map((env) => {
		const on = env === selected;
		const s = rollup(env);
		const look = lookOf(s.state, c);
		const bar = on ? run("▌", c.accent) : run(" ");
		const k = env.namespace;
		const rows = [
			line(`${k} name`, inner, [
				bar,
				run(`${look.glyph} `, look.color),
				run(env.label, on ? c.text : c.soft, { bold: on }),
			]),
			...wrap(env.branch ?? "(detached)", inner - 3).map((piece, i) =>
				line(`${k} branch ${i}`, inner, [bar, run("  "), run(piece, on ? c.soft : c.mute)]),
			),
			line(`${k} note`, inner, [
				bar,
				run("  "),
				removing.has(k)
					? run("being removed…", c.warn)
					: run(s.note, s.state === "running" ? c.mute : look.color),
			]),
		];
		if (!short) rows.push(gap(`${k} gap`));
		return rows;
	});
	const at = snapshot.environments.indexOf(selected);
	const rows = windowed(blocks, at, height - 2, (key, text) =>
		line(key, inner, [run(text, c.mute)]),
	);
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

/**
 * Blocks of rows (an environment, a part) in `room` rows: all when they fit, else a window that
 * holds block `at`, and a row above and below, made by `mark`, saying how many more there are.
 */
function windowed<T>(
	blocks: T[][],
	at: number,
	room: number,
	mark: (key: string, text: string) => T,
): T[] {
	const size = (from: number, to: number) =>
		blocks.slice(from, to + 1).reduce((n, b) => n + b.length, 0);
	const marks = (from: number, to: number) => (from > 0 ? 1 : 0) + (to < blocks.length - 1 ? 1 : 0);
	// From the first block, moved down until block `at` fits; then down as far as room allows.
	let from = 0;
	while (from < at && size(from, at) + marks(from, at) > room) from++;
	let to = Math.max(at, 0);
	while (to + 1 < blocks.length && size(from, to + 1) + marks(from, to + 1) <= room) to++;
	return [
		...(from > 0 ? [mark("above", `↑ ${from} more`)] : []),
		...blocks.slice(from, to + 1).flat(),
		...(to < blocks.length - 1 ? [mark("below", `↓ ${blocks.length - 1 - to} more`)] : []),
	];
}

/**
 * The rows of an environment's parts that show in `room` rows: all of them; else without their
 * headings; else a window that holds the focused part.
 */
function partsShown(
	env: EnvironmentView,
	inner: number,
	room: number,
	short: boolean,
	view: View,
	snapshot?: Snapshot,
	c: Palette = palette("none"),
): Row[] {
	const all = partBlocks(env, inner, short, view, snapshot, c);
	const fits = all.reduce((n, b) => n + b.length, 0) <= room;
	const blocks = fits ? all : partBlocks(env, inner, true, view, snapshot, c);
	const at = partsOf(env).findIndex((part) => part.id === view.focus);
	return windowed(blocks, Math.max(0, at), room, (key, text) => ({
		key,
		runs: [run(text, c.mute)],
	}));
}

/** One row of the parts panel: its runs, none for a blank row. */
interface Row {
	key: string;
	runs: Run[];
}

/**
 * An environment's parts, a block of rows each, `inner` columns wide: apps, then services, each
 * group under a heading unless `short`. A part's address is never cut: where it does not fit
 * beside its name, it goes on rows of its own below it, wrapped where it must be.
 */
function partBlocks(
	env: EnvironmentView,
	inner: number,
	short: boolean,
	view?: View,
	snapshot?: Snapshot,
	c: Palette = palette("none"),
): Row[][] {
	// Narrow, names are not lined up past their own width, and the state word gives way, so an
	// address fits beside its name; the glyph still says the state.
	const nameWidth =
		Math.max(inner < 60 ? 0 : 8, ...partsOf(env).map((p) => [...p.name].length)) + 2;
	const words = inner >= 96;
	const block = (part: Part): Row[] => {
		const look = lookOf(part.state, c);
		const on = view?.focus === part.id;
		const lead = [
			run(on ? "› " : "  ", c.accent, { bold: true }),
			run(`${look.glyph} `, look.color),
			run(pad(part.name, nameWidth), partColor(env, part.id, c), { bold: true }),
			...(words ? [run(pad(look.word, 10), look.color)] : []),
		];
		if (part.state === "failed") {
			const why = lastError(snapshot?.logs.get(part.id));
			const error = [run(part.error ?? "exited", c.bad), run(`  ${why}`, c.soft)];
			return [{ key: part.id, runs: [...lead, ...error] }];
		}
		const color = part.state === "running" ? c.text : c.soft;
		const detail =
			part.state === "idle"
				? run("   starts on its first request", c.dim)
				: run(part.note === undefined ? "" : `   ${part.note}`, c.dim);
		const whole = [...lead, run(part.address, color)];
		if (widthOf(whole) <= inner) {
			// The detail shows where it fits whole.
			const fits = widthOf(whole) + widthOf([detail]) <= inner;
			return [{ key: part.id, runs: fits ? [...whole, detail] : whole }];
		}
		const indent = "    ";
		return [
			{ key: part.id, runs: [...lead, { ...detail, text: detail.text.trimStart() }] },
			...wrap(part.address, inner - indent.length).map((piece, i) => ({
				key: `${part.id} ${i}`,
				runs: [run(indent), run(piece, color)],
			})),
		];
	};
	const group = (heading: string, parts: Part[], first: boolean): Row[][] =>
		parts.map((part, i) => [
			...(i > 0 || short ? [] : first ? [] : [{ key: `${heading} gap`, runs: [] }]),
			...(i > 0 || short ? [] : [{ key: heading, runs: [run(heading, c.dim, { bold: true })] }]),
			...block(part),
		]);
	return [
		...group("APPS", env.apps, true),
		...group("SERVICES", env.services, env.apps.length === 0),
	];
}

/** The selected environment's apps and services: state, address, and a detail. */
function partsPanel(
	env: EnvironmentView,
	view: View,
	snapshot: Snapshot,
	width: number,
	height: number,
	short: boolean,
	c: Palette,
): ReactElement {
	const inner = width - 4;
	const branch = env.branch ?? "(detached)";
	let rows: ReactElement[] = [];
	if (env.problem !== undefined) {
		for (const [i, piece] of wrap(env.problem, inner)
			.slice(0, height - 2)
			.entries()) {
			rows.push(line(`problem ${i}`, inner, [run(piece, c.warn)]));
		}
	} else if (partsOf(env).length === 0) {
		rows.push(line("none", inner, [run("No apps or services in its config.", c.mute)]));
	} else {
		rows = partsShown(env, inner, height - 2, short, view, snapshot, c).map(({ key, runs }) =>
			runs.length === 0 ? gap(key) : line(key, inner, runs),
		);
	}
	return panel(
		"parts",
		width,
		height,
		c.frame,
		// The branch, a name, shows whole or not at all: the sidebar has it whole.
		[
			run(env.label, c.text, { bold: true }),
			...(widthOf([run(`${env.label}  · ${branch}`)]) <= width - 6
				? [run(`  · ${branch}`, c.soft)]
				: []),
		],
		[run(env.dir, c.dim)],
		rows,
	);
}

/** The search in the stream's title: the query being typed, or the one found and how to go on. */
function searchTitle(view: View, c: Palette): Run[] {
	const { search } = view;
	if (search === undefined) return [];
	if (search.typing) {
		return [
			run("  / ", c.accent, { bold: true }),
			run(`${search.query}▏`, c.text, { bold: true }),
			run("  enter find · esc cancel", c.mute),
		];
	}
	return [run(`  “${search.query}”`, c.accent, { bold: true }), run("  n older · N newer", c.mute)];
}

/** `text` with each match of `query` (ignoring case) drawn in reverse. */
function marked(text: string, query: string, color: string | undefined): Run[] {
	if (query === "") return [run(text, color)];
	const runs: Run[] = [];
	const lower = text.toLowerCase();
	const q = query.toLowerCase();
	let from = 0;
	for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
		runs.push(
			run(text.slice(from, at), color),
			run(text.slice(at, at + q.length), color, { inverse: true }),
		);
		from = at + q.length;
	}
	runs.push(run(text.slice(from), color));
	return runs;
}

/** The narrowest a column of logs side by side gets; fewer columns show when they would be less. */
const MIN_COLUMN = 28;

/**
 * The environment's apps' logs in columns, a row at a time: each app's name, wrapped, then its newest lines
 * up to `last` (the newest shown, when paused). A search's match is marked in its column.
 */
function columns(
	env: EnvironmentView,
	snapshot: Snapshot,
	last: number | undefined,
	match: number | undefined,
	search: string,
	width: number,
	height: number,
	c: Palette,
): ReactElement[] {
	if (env.apps.length === 0) return [];
	const fit = Math.max(1, Math.floor((width + 3) / (MIN_COLUMN + 3)));
	const apps = env.apps.slice(0, fit);
	const more = env.apps.length - apps.length;
	// The apps that don't fit are told on a row of their own, so the columns keep their width.
	const top =
		more > 0 ? [line("more", width, [run(`+${more} more: widen the terminal`, c.dim)])] : [];
	const tall = height - top.length;
	const each = Math.floor((width - 3 * (apps.length - 1)) / apps.length);
	const bound = last ?? Number.POSITIVE_INFINITY;
	const cells = apps.map((app) => {
		const color = partColor(env, app.id, c);
		// The name wraps in its column rather than be cut.
		const title = wrap(app.name, Math.max(1, each - 2)).map((piece, i) =>
			cut([run(i === 0 ? "■ " : "  ", color), run(piece, color, { bold: true })], each),
		);
		const lines = (snapshot.logs.get(app.id) ?? [])
			.filter((l) => l.seq <= bound)
			.slice(-Math.max(0, tall - title.length));
		return [
			...title,
			...lines.map((l) =>
				cut(
					[
						run(l.time, c.dim),
						run(search !== "" && l.seq === match ? "›" : " ", c.warn, { bold: true }),
						...marked(clean(l.text), search, tone(l.text, c)),
					],
					each,
				),
			),
		];
	});
	const rows = top;
	for (let i = 0; i < tall; i++) {
		const runs = cells.flatMap((cell, k) => [
			...(k === 0 ? [] : [run(" │ ", c.frame)]),
			...(cell[i] ?? [run(" ".repeat(each))]),
		]);
		rows.push(line(`row ${i}`, width, runs));
	}
	return rows;
}

/** `runs` cut to `width` columns with `…`, or padded to it. */
function cut(runs: Run[], width: number): Run[] {
	const out = clip(runs, width);
	return [...out, run(" ".repeat(Math.max(0, width - widthOf(out))))];
}

/** `runs` cut to at most `width` columns with `…`. */
function clip(runs: Run[], width: number): Run[] {
	const out: Run[] = [];
	let left = width;
	for (const r of runs) {
		const chars = [...r.text];
		if (chars.length <= left) {
			out.push(r);
			left -= chars.length;
			continue;
		}
		out.push({ ...r, text: `${chars.slice(0, Math.max(0, left - 1)).join("")}…` });
		return out;
	}
	return out;
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
	// Paused, the page ends at its line, or fills with the lines after it near the oldest.
	const paused = view.until;
	const all = paused === undefined ? [] : streamLines(snapshot, view);
	const end = Math.max(
		all.filter((l) => l.seq <= (paused as number)).length,
		Math.min(n, all.length),
	);
	const shown =
		paused === undefined ? merged(snapshot.logs, ids, n) : all.slice(Math.max(0, end - n), end);
	const search = view.search !== undefined && !view.search.typing ? view.search.query : "";
	const rows = view.sideBySide
		? columns(
				env,
				snapshot,
				paused === undefined ? undefined : shown.at(-1)?.seq,
				paused,
				search,
				inner,
				n,
				c,
			)
		: shown.map((l) => {
				const color = partColor(env, l.id, c);
				const name = parts.find((part) => part.id === l.id)?.name ?? l.id;
				const match = search !== "" && l.seq === paused;
				return line(`${l.seq}`, inner, [
					run(`${l.time} `, c.dim),
					run(match ? "› " : "  ", c.warn, { bold: true }),
					...(focused === undefined ? [run("▎", color), run(pad(name, nameWidth), color)] : []),
					...marked(clean(l.text), search, tone(l.text, c)),
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
	const mode = [
		run("LOGS", c.mute, { bold: true }),
		view.sideBySide
			? run("  side by side", c.soft)
			: run(
					focused === undefined ? "  all" : `  ${focused.name} only`,
					focused ? c.accent : c.soft,
				),
	];
	const found = searchTitle(view, c);
	// Paused, the title says how to go live; where the whole hint won't fit, the count goes first.
	const live = [` · ${all.length - end} newer · end for live`, " · end for live"];
	const room = inner - 2 - widthOf([...mode, ...found]) - widthOf([run("  ⏸ paused")]);
	const hint = live.find((text) => [...text].length <= room) ?? (live[1] as string);
	return panel(
		"stream",
		width,
		height,
		focused === undefined || view.sideBySide ? c.frame : c.focus,
		[
			...mode,
			...(paused === undefined
				? []
				: [run("  ⏸ paused", c.warn, { bold: true }), run(hint, c.soft)]),
			...found,
		],
		legend,
		rows,
	);
}
