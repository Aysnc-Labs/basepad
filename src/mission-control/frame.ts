import { Box, Text } from "ink";
import { createElement as h, type ReactElement, type ReactNode } from "react";
import { ofDaemon } from "../layout.ts";
import {
	type EnvironmentView,
	type LogLine,
	type Part,
	type PartState,
	partsOf,
	printed,
	type Snapshot,
	selectedOf,
	streamIds,
	streamLines,
	type View,
} from "./model.ts";

export interface FrameInput {
	snapshot: Snapshot;
	view: View;
	cols: number;
	rows: number;
	now: string;
	color: Colors;
	clock?: number;
	changed?: ReadonlyMap<string, number>;
	noticeAge?: number;
}

export type Colors = "none" | "16" | "rgb";

/**
 * The colours for a terminal: none when `NO_COLOR` is set to anything but empty
 * (https://no-color.org), which chalk ignores; else by chalk's colour `level` for the terminal.
 */
export function colorsFor(noColor: string | undefined, level: number): Colors {
	if (noColor !== undefined && noColor !== "") return "none";
	return level >= 2 ? "rgb" : level === 1 ? "16" : "none";
}

export const MIN_COLS = 72;
export const MIN_ROWS = 16;
const SHORT_ROWS = 24;

export function frame(input: FrameInput): ReactElement {
	const { snapshot, view, cols, rows, now, color } = input;
	const c: Palette = { ...palette(color), motion: motionOf(input) };
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
				view.help
					? help(right, body - table, c)
					: stream(env, view, snapshot, right, body - table, c),
			),
		),
		...bottom,
	);
}

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
	const bottom = [
		...(said.length === 0 && !short ? [gap("g4")] : said),
		...footer(cols, short, snapshot.environments.length, c),
	];
	const body = rows - top.length - bottom.length;
	const side = Math.min(34, Math.max(24, Math.floor(cols * 0.2)));
	const right = cols - side - 1;
	const keep = Math.max(short ? 4 : 6, Math.floor(body / 3));
	const most = Math.max(short ? 3 : 6, body - keep);
	const table =
		env.problem !== undefined
			? Math.min(6, most)
			: partsOf(env).length === 0
				? 3
				: Math.max(3, Math.min(most, 2 + partsShown(env, right - 4, most - 2, short, view).length));
	return { top, bottom, body, side, right, table, short };
}

export function pageOf(snapshot: Snapshot, view: View, cols: number, rows: number): number {
	const env = selectedOf(snapshot, view);
	if (env === undefined || cols < MIN_COLS || rows < MIN_ROWS) return 10;
	const { body, table } = arrange(snapshot, view, env, cols, rows, "", palette("none"));
	return Math.max(1, body - table - 2);
}

type Color = string | undefined;
export interface Palette {
	motion?: Motion;
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
	parts: Color[];
}

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

export function palette(colors: Colors): Palette {
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
	starting: { glyph: "◉", word: "starting", tone: "warn" },
	failed: { glyph: "✖", word: "failed", tone: "bad" },
	stopped: { glyph: "–", word: "stopped", tone: "dim" },
	idle: { glyph: "○", word: "idle", tone: "dim" },
};

function partColor(env: EnvironmentView, id: string, c: Palette): string | undefined {
	const i = partsOf(env).findIndex((part) => part.id === id);
	return c.parts[Math.max(0, i) % c.parts.length];
}

const BREATH_MS = 1400;
const FLASH_MS = 1200;
const FADE_IN_MS = 350;
export const NOTICE_MS = 4000;
export const NOTICE_FADE_MS = 1000;
const BACKGROUND = "#1a1b26";

interface Motion {
	rgb: boolean;
	clock: number;
	changed: ReadonlyMap<string, number>;
	noticeAge?: number;
}

function motionOf({ clock = 0, changed = new Map(), noticeAge, color }: FrameInput): Motion {
	return {
		rgb: color === "rgb",
		clock,
		changed,
		...(noticeAge === undefined ? {} : { noticeAge }),
	};
}

export function animating({
	snapshot,
	clock,
	changed,
	noticeAge,
}: Pick<FrameInput, "snapshot" | "changed" | "noticeAge"> & { clock: number }): boolean {
	const parts = snapshot.environments.flatMap((env) => [...env.apps, ...env.services]);
	if (parts.some((part) => part.state === "starting")) return true;
	for (const at of changed?.values() ?? []) if (clock - at < FLASH_MS) return true;
	for (const lines of snapshot.logs.values()) {
		const at = lines.at(-1)?.at;
		if (at !== undefined && clock - at < FADE_IN_MS) return true;
	}
	return (
		noticeAge !== undefined && noticeAge >= NOTICE_MS && noticeAge < NOTICE_MS + NOTICE_FADE_MS
	);
}

function mix(from: string, to: string, t: number): string {
	const k = Math.max(0, Math.min(1, t));
	const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	return `#${[0, 1, 2]
		.map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * k))
		.map((n) => n.toString(16).padStart(2, "0"))
		.join("")}`;
}

function breathe(color: string | undefined, c: Palette): string | undefined {
	const m = c.motion;
	if (m === undefined || !m.rgb || color === undefined || c.dim === undefined) return color;
	const t = (1 - Math.cos((2 * Math.PI * m.clock) / BREATH_MS)) / 2;
	return mix(color, c.dim, t * 0.8);
}

function glow(id: string, color: string | undefined, c: Palette): string | undefined {
	const m = c.motion;
	const at = m?.changed.get(id);
	if (m === undefined || !m.rgb || at === undefined || color === undefined) return undefined;
	const age = m.clock - at;
	if (age < 0 || age >= FLASH_MS) return undefined;
	return mix(mix(color, BACKGROUND, 0.6), BACKGROUND, age / FLASH_MS);
}

function settled(line: LogLine, color: string | undefined, c: Palette): string | undefined {
	const m = c.motion;
	if (
		m === undefined ||
		!m.rgb ||
		line.at === undefined ||
		color === undefined ||
		c.dim === undefined
	)
		return color;
	const age = m.clock - line.at;
	return age >= FADE_IN_MS ? color : mix(c.dim, color, Math.max(0, age) / FADE_IN_MS);
}

function fading(color: string | undefined, c: Palette): string | undefined {
	const age = c.motion?.noticeAge;
	if (!c.motion?.rgb || age === undefined || color === undefined || c.dim === undefined)
		return color;
	return age <= NOTICE_MS ? color : mix(color, c.dim, (age - NOTICE_MS) / NOTICE_FADE_MS);
}

interface Run {
	text: string;
	color?: string | undefined;
	bg?: string | undefined;
	bold?: boolean;
	inverse?: boolean;
}

const run = (text: string, color?: string, more: Omit<Run, "text" | "color"> = {}): Run => ({
	text,
	color,
	...more,
});

const widthOf = (runs: Run[]) => runs.reduce((n, r) => n + [...r.text].length, 0);

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

const pad = (text: string, n: number) => text + " ".repeat(Math.max(0, n - [...text].length));

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

const titleRoom = (width: number) => width - 6;

function panel(
	key: string,
	width: number,
	height: number,
	border: string | undefined,
	title: Run[],
	right: Run[],
	children: ReactNode[],
): ReactElement {
	const t = title.length > 0 ? clip([run(" "), ...title, run(" ")], titleRoom(width) + 2) : [];
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
	return {
		glyph: s.glyph,
		word: s.word,
		color: state === "starting" ? breathe(c[s.tone], c) : c[s.tone],
	};
}

function tone(text: string, c: Palette): string | undefined {
	if (/\b(ERROR|FATAL|PANIC)\b|Error\b|^\s+at |exception|^Node\.js v/.test(text)) return c.bad;
	if (/\bWARN(ING)?\b/.test(text)) return c.warn;
	return c.text;
}

/**
 * A line without the date, zone and pid a server stamps on it itself (Postgres does):
 * https://www.postgresql.org/docs/current/runtime-config-logging.html#GUC-LOG-LINE-PREFIX
 */
const clean = (text: string) =>
	text.replace(
		/^\s*\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d| [A-Z]{2,5})?\]?\s+(?:\[\d+\]\s+)?/,
		"",
	);

const LAST_OUTPUT = 20;

function lastError(lines: readonly LogLine[] = []): string {
	const recent = lines
		.slice(-LAST_OUTPUT)
		.map((l) => l.text.trim())
		.filter((text) => text !== "");
	return recent.findLast((text) => /Error\b|ERROR|FATAL/.test(text)) ?? recent.at(-1) ?? "";
}

function merged(logs: Snapshot["logs"], ids: string[], n: number): LogLine[] {
	const all: LogLine[] = [];
	for (const id of ids) all.push(...(logs.get(id) ?? []).filter(printed).slice(-n));
	return all.sort((a, b) => a.seq - b.seq).slice(-n);
}

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
		...(count("idle") > 0 ? [run("○ ", c.dim), run(`${count("idle")} idle   `, c.soft)] : []),
		...(count("stopped") > 0
			? [run("– ", c.dim), run(`${count("stopped")} stopped   `, c.soft)]
			: []),
		run("⇣ ", c.mute),
		run(`${snapshot.rate}${wide ? " lines/s" : "/s"}   `, c.soft),
		run(now, c.text, { bold: true }),
		run(" "),
	];
	const fill = Math.max(1, cols - widthOf(left) - widthOf(right));
	return line("header", cols, [...left, run(" ".repeat(fill)), ...right]);
}

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
				run(` ${STATES.starting.glyph} `, breathe(c.warn, c), { bold: true }),
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
		said = [run(view.notice, fading(c.accent, c))];
	}
	const rows = said.length === 0 ? [] : flow(said, cols - 2).slice(0, short ? 2 : 3);
	return [...work, ...rows.map((runs, i) => line(`said ${i}`, cols, [run(" "), ...runs]))];
}

function keysOf(environments: number): [string, string][] {
	return [
		["↑↓", "select"],
		...(environments > 1 ? ([["tab", "environment"]] as [string, string][]) : []),
		["enter", "open"],
		["space", "start/stop"],
		["r", "restart"],
		["/", "search"],
		["?", "all keys"],
		["q", "close"],
	];
}

const HELP: [string, string][] = [
	["↑↓", "select an app or service; above the first, all of them"],
	["tab ⇧tab", "next or previous environment (← → too)"],
	["1–9", "go to an environment, by its number"],
	["enter", "open the selected app, else the first"],
	["space", "start or stop it"],
	["r", "restart it, else the whole environment"],
	["c", "copy its address"],
	["/", "search the logs"],
	["n N", "older and newer match"],
	["PgUp PgDn", "scroll the logs; Home and End for the oldest and live"],
	["a", "add a worktree"],
	["d", "remove the selected worktree"],
	["esc", "back a step"],
	["q", "close mission control; everything keeps running"],
];

function footer(cols: number, short: boolean, environments: number, c: Palette): ReactElement[] {
	const rows: Run[][] = [[run(" ")]];
	const space = short ? "  " : "   ";
	for (const [k, label] of keysOf(environments)) {
		const key = short ? k : ` ${k} `;
		const item = [run(key, c.text, { bg: c.keyBg, bold: true }), run(` ${label}${space}`, c.mute)];
		let last = rows[rows.length - 1] as Run[];
		if (widthOf(last) + widthOf(item) - space.length >= cols && last.length > 1) {
			last = [run(" ")];
			rows.push(last);
		}
		last.push(...item);
	}
	return rows.map((runs, i) => {
		const end = runs[runs.length - 1] as Run;
		const trimmed = [...runs.slice(0, -1), { ...end, text: end.text.trimEnd() }];
		return line(`keys ${i}`, cols, trimmed);
	});
}

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
	const digits = String(snapshot.environments.length).length;
	const indent = run(" ".repeat(digits + 3));
	const blocks = snapshot.environments.map((env, i) => {
		const on = env === selected;
		const s = rollup(env);
		const look = lookOf(s.state, c);
		const bar = on ? run("▌", c.accent) : run(" ");
		const k = env.namespace;
		const branch = env.branch ?? "(detached)";
		const rows = [
			line(`${k} name`, inner, [
				bar,
				run(`${String(i + 1).padStart(digits)} `, c.dim),
				run(`${look.glyph} `, look.color),
				run(env.label, on ? c.text : c.soft, { bold: on }),
			]),
			...(branch === env.label ? [] : wrap(branch, inner - indent.text.length - 1)).map(
				(piece, j) =>
					line(`${k} branch ${j}`, inner, [bar, indent, run(piece, on ? c.soft : c.mute)]),
			),
			...(removing.has(k)
				? [line(`${k} note`, inner, [bar, indent, run("being removed…", c.warn)])]
				: s.state === "running"
					? []
					: [line(`${k} note`, inner, [bar, indent, run(s.note, look.color)])]),
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

function windowed<T>(
	blocks: T[][],
	at: number,
	room: number,
	mark: (key: string, text: string) => T,
): T[] {
	const size = (from: number, to: number) =>
		blocks.slice(from, to + 1).reduce((n, b) => n + b.length, 0);
	const marks = (from: number, to: number) => (from > 0 ? 1 : 0) + (to < blocks.length - 1 ? 1 : 0);
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

interface Row {
	key: string;
	runs: Run[];
}

function partBlocks(
	env: EnvironmentView,
	inner: number,
	short: boolean,
	view?: View,
	snapshot?: Snapshot,
	c: Palette = palette("none"),
): Row[][] {
	const nameWidth =
		Math.max(inner < 60 ? 0 : 8, ...partsOf(env).map((p) => [...p.name].length)) + 2;
	const words = inner >= 96;
	const block = (part: Part): Row[] => {
		const bg = glow(part.id, lookOf(part.state, c).color, c);
		const rows = plainBlock(part);
		if (bg === undefined) return rows;
		return rows.map((row) => ({ ...row, runs: row.runs.map((r) => ({ ...r, bg: r.bg ?? bg })) }));
	};
	const plainBlock = (part: Part): Row[] => {
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
				: run(part.note === undefined || !on ? "" : `   ${part.note}`, c.dim);
		const address = part.address ?? "";
		const whole = [...lead, run(address, color)];
		if (widthOf(whole) <= inner) {
			const fits = widthOf(whole) + widthOf([detail]) <= inner;
			return [{ key: part.id, runs: fits ? [...whole, detail] : whole }];
		}
		const indent = "    ";
		return [
			{ key: part.id, runs: [...lead, { ...detail, text: detail.text.trimStart() }] },
			...wrap(address, inner - indent.length).map((piece, i) => ({
				key: `${part.id} ${i}`,
				runs: [run(indent), run(piece, color)],
			})),
		];
	};
	const group = (heading: string, parts: Part[]): Row[][] =>
		parts.map((part, i) => [
			...(i > 0 || short ? [] : [{ key: heading, runs: [run(heading, c.dim, { bold: true })] }]),
			...block(part),
		]);
	return [...group("APPS", env.apps), ...group("SERVICES", env.services)];
}

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
		[
			run(env.label, c.text, { bold: true }),
			...(branch !== env.label && widthOf([run(`${env.label}  · ${branch}`)]) <= width - 6
				? [run(`  · ${branch}`, c.soft)]
				: []),
		],
		[run(env.dir, c.dim)],
		rows,
	);
}

function searchTitle(view: View, c: Palette): Piece[] {
	const { search } = view;
	if (search === undefined) return [];
	if (search.typing) {
		const typed = (text: string) => [
			run("  / ", c.accent, { bold: true }),
			run(`${text}▏`, c.text, { bold: true }),
		];
		const chars = [...search.query];
		return [
			{
				runs: typed(search.query),
				shrink: (cols) => typed(`…${chars.slice(chars.length - Math.max(0, cols - 6)).join("")}`),
			},
			{ runs: [run("  enter find · esc cancel", c.mute)], gives: HINT },
		];
	}
	return [
		{ runs: [run(`  “${search.query}”`, c.accent, { bold: true })], gives: QUERY },
		{ runs: [run("  n older · N newer", c.mute)], gives: HINT },
	];
}

interface Piece {
	runs: Run[];
	gives?: number;
	shrink?: (cols: number) => Run[];
}

const NEWER = 1;
const HINT = 2;
const LIVE_HINT = 3;
const NAME = 4;
const QUERY = 5;

function fitted(pieces: Piece[], room: number): Run[] {
	let kept = pieces;
	const order = pieces
		.filter((p) => p.gives !== undefined)
		.sort((a, b) => (a.gives ?? 0) - (b.gives ?? 0));
	for (const piece of order) {
		if (widthOf(kept.flatMap((p) => p.runs)) <= room) break;
		kept = kept.filter((p) => p !== piece);
	}
	const over = widthOf(kept.flatMap((p) => p.runs)) - room;
	return kept.flatMap((p) =>
		over > 0 && p.shrink !== undefined ? p.shrink(widthOf(p.runs) - over) : p.runs,
	);
}

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
		if (left > 0) out.push({ ...r, text: `${chars.slice(0, left - 1).join("")}…` });
		return out;
	}
	return out;
}

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
	const ids = streamIds(snapshot, view);
	const inner = width - 4;
	const n = Math.max(0, height - 2);
	const named = [
		...parts.map((p) => p.name),
		...ids.filter((id) => snapshot.logs.has(id)).map((id) => ofDaemon(id).name),
	];
	const nameWidth = Math.max(...named.map((name) => [...name].length), 3) + 2;
	const paused = view.until;
	const all = paused === undefined ? [] : streamLines(snapshot, view);
	const end = Math.max(
		all.filter((l) => l.seq <= (paused as number)).length,
		Math.min(n, all.length),
	);
	const shown =
		paused === undefined ? merged(snapshot.logs, ids, n) : all.slice(Math.max(0, end - n), end);
	const search = view.search !== undefined && !view.search.typing ? view.search.query : "";
	const rows = shown.map((l) => {
		const color = partColor(env, l.id, c);
		const name = parts.find((part) => part.id === l.id)?.name ?? ofDaemon(l.id).name;
		const match = search !== "" && l.seq === paused;
		return line(`${l.seq}`, inner, [
			run(`${l.time} `, c.dim),
			run(match ? "› " : "  ", c.warn, { bold: true }),
			...(focused === undefined ? [run("▎", color), run(pad(name, nameWidth), color)] : []),
			...marked(clean(l.text), search, settled(l, tone(l.text, c), c)),
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
	const mode: Piece = {
		runs: [
			run(focused === undefined ? "  all" : `  ${focused.name} only`, focused ? c.accent : c.soft),
		],
		gives: NAME,
	};
	const live: Piece[] =
		paused === undefined
			? []
			: [
					{ runs: [run("  ‖ paused", c.warn, { bold: true })] },
					{ runs: [run(` · ${all.length - end} newer`, c.soft)], gives: NEWER },
					{ runs: [run(" · end for live", c.soft)], gives: LIVE_HINT },
				];
	const title = fitted(
		[{ runs: [run("LOGS", c.mute, { bold: true })] }, mode, ...live, ...searchTitle(view, c)],
		titleRoom(width),
	);
	return panel("stream", width, height, focused === undefined ? c.frame : c.focus, title, [], rows);
}

function help(width: number, height: number, c: Palette): ReactElement {
	const inner = width - 4;
	const keyWidth = Math.max(...HELP.map(([k]) => [...k].length)) + 3;
	const rows = HELP.slice(0, Math.max(0, height - 2)).map(([k, what]) =>
		line(`help ${k}`, inner, [run(pad(k, keyWidth), c.text, { bold: true }), run(what, c.soft)]),
	);
	return panel(
		"help",
		width,
		height,
		c.focus,
		[run("KEYS", c.mute, { bold: true }), run("  ? or esc to go back", c.dim)],
		[],
		rows,
	);
}
