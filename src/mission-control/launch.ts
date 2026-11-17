import { Box, render, Text } from "ink";
import { createElement as h, type ReactElement } from "react";
import { type Colors, type Palette, palette } from "./frame.ts";

export interface Check {
	name: string;
	state: "waiting" | "active" | "go" | "nogo";
}

export interface LaunchInput {
	title: string;
	subtitle: string;
	checks: Check[];
	tick: number;
	lift: number;
	elapsed?: number;
	note?: string;
	cols: number;
	rows?: number;
	color: Colors;
}

const withArt = ({ cols, rows, color }: LaunchInput) =>
	color === "rgb" && cols >= ART_COLS && (rows ?? Number.POSITIVE_INFINITY) >= MIN_ART_ROWS + 2;

const artRows = (rows: number) => Math.min(ART_ROWS, rows - 2);

export function launchFrame(input: LaunchInput): ReactElement {
	const c = palette(input.color);
	const seconds = input.elapsed === undefined ? undefined : Math.floor(input.elapsed);
	const clock =
		seconds === undefined
			? undefined
			: `T+${[seconds / 3600, (seconds / 60) % 60, seconds % 60]
					.map((n) => String(Math.floor(n)).padStart(2, "0"))
					.join(":")}`;
	return beside(
		withArt(input)
			? pixels(scene(input).slice(-2 * artRows(input.rows ?? Number.POSITIVE_INFINITY)), c)
			: [],
		checklist(
			{
				...input,
				lamp: "GO",
				status: launchStatus(input, c),
				...(clock === undefined ? {} : { clock }),
			},
			c,
		),
	);
}

function beside(art: ReactElement[], list: ReactElement): ReactElement {
	return h(
		Box,
		{ flexDirection: "row", gap: 4, paddingX: 1, paddingY: 1 },
		...(art.length > 0 ? [h(Box, { key: "art", flexDirection: "column" }, ...art)] : []),
		list,
	);
}

function launchStatus({ checks, lift }: LaunchInput, c: Palette): Said {
	const failed = checks.find((check) => check.state === "nogo");
	if (failed !== undefined) return [`NO-GO  ·  ${failed.name}`, c.bad];
	if (checks.every((check) => check.state === "go"))
		return lift > 0 ? ["LIFT-OFF", c.ok] : ["ALL SYSTEMS GO", c.ok];
	return ["PRE-LAUNCH CHECKS", c.warn];
}

const ART_COLS = 70;
const ART_ROWS = 18;
const MIN_ART_ROWS = 13;
const WIDTH = 34;

type Said = [string, string | undefined];

interface List {
	title: string;
	subtitle: string;
	checks: Check[];
	lamp: string;
	status: Said;
	clock?: string;
	note?: string;
}

function checklist(list: List, c: Palette): ReactElement {
	const rule = h(Text, { color: c.dim }, "─".repeat(WIDTH));
	const onLamp = c.keyBg === undefined ? undefined : "#1a1b26";
	const lit = (text: string, bg: string | undefined) =>
		h(Text, { color: onLamp, backgroundColor: bg, bold: true }, ` ${text} `);
	const rows = list.checks.map((check) => {
		const on = check.state !== "waiting";
		const lamp =
			check.state === "go"
				? lit(list.lamp, c.ok)
				: check.state === "nogo"
					? lit("NO-GO", c.bad)
					: check.state === "active"
						? h(Text, { color: c.warn, bold: true }, " ·· ")
						: h(Text, null, "");
		return h(
			Text,
			{ key: check.name },
			h(Text, { color: on ? c.text : c.dim }, check.name.padEnd(WIDTH - 8, on ? "." : " ")),
			lamp,
		);
	});
	const [said, tone] = list.status;
	return h(
		Box,
		{ key: "checklist", flexDirection: "column", justifyContent: "center" },
		h(
			Text,
			null,
			h(Text, { color: c.text, bold: true }, "BASEPAD"),
			h(Text, { color: c.dim }, "  │  "),
			h(Text, { color: c.mute }, list.title),
		),
		h(Text, { color: c.dim }, list.subtitle.toUpperCase()),
		rule,
		...rows,
		rule,
		h(
			Text,
			null,
			...(list.clock === undefined
				? []
				: [h(Text, { key: "clock", color: c.text, bold: true }, list.clock.padEnd(14))]),
			h(Text, { color: tone, bold: true }, said),
		),
		...(list.note === undefined ? [] : [h(Text, { key: "note", color: c.mute }, list.note)]),
	);
}

const ROCKET = [
	"....S....",
	"....S....",
	"...SwS...",
	"...WWw...",
	"..WWWWw..",
	"..DDDDD..",
	"..WWWWw..",
	"..WKWWw..",
	"..DDDDD..",
	"..WWWWw..",
	"..WWWKw..",
	"..WWWWw..",
	"..DDDDD..",
	"..BBBBB..",
	"..WWWWw..",
	"..WKKWw..",
	"..WKKWw..",
	"..WWWWw..",
	"..WWWKK..",
	".DWWWKKD.",
	"DDWWWWwDD",
	"D.SSSSS.D",
];
const FLAME = [
	["...LLL...", "...YLY...", "....Y...."],
	["...LLL...", "...LYL...", "...YOY...", "....O...."],
];
const PLUME = [
	["..LLLLL..", "..YLLLY..", "...YYY...", "...OYO...", "....O....", "....O...."],
	["..LLLLL..", "..LLLLL..", "...YLY...", "...YOY...", "...O.O...", "....O...."],
];

const WIDE = 26;
const TALL = 36;
const ROCKET_X = 12;
const PAD = TALL - 3;
const ROCKET_TOP = PAD - ROCKET.length - 1;
const STARS: [number, number][] = [
	[1, 2],
	[22, 5],
	[8, 1],
	[24, 14],
	[17, 0],
];

function canvas() {
	const px = Array.from({ length: TALL }, () => Array<string>(WIDE).fill("."));
	const put = (x: number, y: number, ch: string) => {
		const row = px[y];
		if (ch !== "." && row !== undefined && x >= 0 && x < WIDE) row[x] = ch;
	};
	const stamp = (rows: string[], x: number, y: number) => {
		for (const [dy, row] of rows.entries())
			for (const [dx, ch] of [...row].entries()) put(x + dx, y + dy, ch);
	};
	return { rows: () => px.map((row) => row.join("")), put, stamp };
}

const TOWER_TOP = ROCKET_TOP - 2;
const BEACON: [number, number] = [5, TOWER_TOP - 2];

function ground(put: (x: number, y: number, ch: string) => void, armsIn: boolean) {
	for (const [x, y] of STARS) put(x, y, "*");
	for (let y = TOWER_TOP; y < PAD; y++) {
		put(3, y, "T");
		put(7, y, "T");
		put(4 + ((y - TOWER_TOP) % 3), y, "t");
	}
	put(5, TOWER_TOP - 1, "T");
	put(...BEACON, "t");
	for (const y of [ROCKET_TOP + 4, ROCKET_TOP + 10, ROCKET_TOP + 16])
		for (let x = 8; x < (armsIn ? ROCKET_X + 2 : 10); x++) put(x, y, "T");
	for (let x = 0; x < WIDE; x++) put(x, PAD, "D");
	for (let x = 1; x < WIDE - 1; x++) put(x, PAD + 1, x > 10 && x < 22 ? "K" : "D");
}

function scene({ checks, tick, lift }: LaunchInput): string[] {
	const { rows, put, stamp } = canvas();
	const go = checks.every((check) => check.state === "go");
	ground(put, !go);
	if (tick % 10 < 5) put(...BEACON, "R");
	const top = ROCKET_TOP - lift;
	stamp(ROCKET, ROCKET_X, top);
	if (go) stamp((lift > 0 ? PLUME : FLAME)[tick % 2] as string[], ROCKET_X, top + ROCKET.length);
	if (lift > 0) for (let x = 0; x < WIDE; x++) if ((x + tick) % 3 !== 0) put(x, PAD - 1, "S");
	return rows();
}

export function rocketArt() {
	const { rows, put } = canvas();
	ground(put, false);
	return {
		wide: WIDE,
		tall: TALL,
		ground: rows(),
		beacon: BEACON,
		rocket: ROCKET,
		flames: FLAME,
		plumes: PLUME,
		x: ROCKET_X,
		top: ROCKET_TOP,
		colours: colours(palette("rgb")),
	};
}

function colours(c: Palette): Record<string, string | undefined> {
	return {
		W: c.text,
		w: c.soft,
		S: c.mute,
		B: c.accent,
		Y: c.warn,
		R: c.bad,
		"*": c.dim,
		T: c.dim,
		D: "#414868",
		K: "#24283b",
		t: "#3b4261",
		L: "#fff1c1",
		O: "#ff9e64",
	};
}

function pixels(rows: string[], c: Palette): ReactElement[] {
	const colour = colours(c);
	const out: ReactElement[] = [];
	for (let y = 0; y < rows.length; y += 2) {
		const top = [...(rows[y] as string)];
		const bottom = [...(rows[y + 1] ?? "")];
		out.push(
			h(
				Text,
				{ key: y },
				...top.map((t, x) => {
					const b = bottom[x] ?? ".";
					if (t === "." && b === ".") return h(Text, { key: x }, " ");
					if (t === ".") return h(Text, { key: x, color: colour[b] }, "▄");
					if (b === ".") return h(Text, { key: x, color: colour[t] }, "▀");
					return h(Text, { key: x, color: colour[t], backgroundColor: colour[b] }, "▀");
				}),
			),
		);
	}
	return out;
}

export interface LandingInput {
	project: string;
	environment: string;
	parts: string[];
	kept?: string[];
	state: "stopping" | "stopped" | "failed";
	tick: number;
	drop: number;
	cols: number;
	color: Colors;
}

export function landingFrame(input: LandingInput): ReactElement {
	const c = palette(input.color);
	const art = input.color === "rgb" && input.cols >= ART_COLS;
	const lamp: Check["state"] =
		input.state === "stopped" ? "go" : input.state === "failed" ? "nogo" : "active";
	const status: Said =
		input.state === "stopped"
			? ["SPLASHDOWN  ·  all stopped", c.ok]
			: input.state === "failed"
				? ["NO-GO  ·  not everything stopped", c.bad]
				: ["DESCENT", c.warn];
	const kept = input.kept ?? [];
	const names = kept.map((key) => `\`${key}\``).join(", ");
	const note =
		input.state !== "stopped"
			? undefined
			: kept.length === 0
				? "`basepad up` relaunches."
				: `${names} ${kept.length > 1 ? "run" : "runs"} on main's and keep${kept.length > 1 ? "" : "s"} running. \`basepad up\` relaunches.`;
	return beside(
		art ? pixels(capsule(input), c) : [],
		checklist(
			{
				...input,
				subtitle: `${input.project}  ·  ${input.environment}`,
				title: "SPLASHDOWN",
				lamp: "SAFE",
				checks: input.parts.map((name) => ({ name, state: lamp })),
				status,
				...(note === undefined ? {} : { note }),
			},
			c,
		),
	);
}

const CHUTE = [
	"......RRWWRR......",
	"...RRWWRRWWRRWW...",
	"..WWRRWWRRWWRRWW..",
	".RRWWRRWWRRWWRRWW.",
	"RRWWRRWWRRWWRRWWRR",
	"t.......t........t",
];
const CAPSULE = ["...W...", "..WWw..", ".WWWWw.", "WWWWWww", "DDDDDDD"];

function capsule({ tick, drop, state }: LandingInput): string[] {
	const px = Array.from({ length: TALL }, () => Array<string>(WIDE).fill("."));
	const put = (x: number, y: number, ch: string) => {
		const row = px[y];
		if (ch !== "." && row !== undefined && x >= 0 && x < WIDE) row[x] = ch;
	};
	const stamp = (rows: string[], x: number, y: number) => {
		for (const [dy, row] of rows.entries())
			for (const [dx, ch] of [...row].entries()) put(x + dx, y + dy, ch);
	};
	for (const [x, y] of STARS) put(x, y, "*");
	const sea = TALL - 4;
	const down = state === "stopped";
	const lowest = sea - CAPSULE.length - CHUTE.length - 7;
	const y = down ? sea - CAPSULE.length - CHUTE.length - 5 : Math.min(lowest, drop);
	const sway = down ? 0 : tick % 20 < 10 ? 0 : 1;
	const x = 4 + sway;
	if (!down) {
		stamp(CHUTE, x, y);
		for (let i = 1; i <= 5; i++) {
			const row = y + CHUTE.length - 1 + i;
			put(x + 1 + Math.round((i * 7) / 5), row, "t");
			put(x + 16 - Math.round((i * 6) / 5), row, "t");
			put(x + 9, row, "t");
		}
	}
	const capsuleY = down ? sea - CAPSULE.length + 1 : y + CHUTE.length + 5;
	stamp(CAPSULE, x + 6, capsuleY);
	for (let row = sea; row < TALL; row++)
		for (let col = 0; col < WIDE; col++) put(col, row, (col + tick + row) % 4 === 0 ? "w" : "B");
	if (down) for (const dx of [-1, 7, -2, 8]) put(x + 6 + dx, sea - 1 - (Math.abs(dx) % 2), "w");
	return px.map((row) => row.join(""));
}

const BEAT_MS = 100;

const SPLASH_MS = 300;

export interface Landing {
	land(): Promise<void>;
	fail(): void;
}

export function landing(options: {
	project: string;
	environment: string;
	parts: string[];
	kept?: string[];
	color: Colors;
}): Landing {
	let tick = 0;
	let state: LandingInput["state"] = "stopping";
	const draw = () =>
		landingFrame({
			...options,
			state,
			tick,
			drop: Math.floor(tick / 2),
			cols: process.stdout.columns || Number(process.env.COLUMNS) || 80,
		});
	const app = render(draw(), { exitOnCtrlC: true, patchConsole: false });
	const timer = setInterval(() => {
		tick++;
		app.rerender(draw());
	}, BEAT_MS);
	const close = (then: LandingInput["state"]) => {
		clearInterval(timer);
		state = then;
		app.rerender(draw());
	};
	return {
		async land() {
			close("stopped");
			await new Promise((resolve) => setTimeout(resolve, SPLASH_MS));
			app.unmount();
		},
		fail() {
			close("failed");
			app.unmount();
		},
	};
}

const SETUP_LIFT_OFF_MS = 1500;

export async function liftOff(input: Omit<LaunchInput, "tick" | "lift">): Promise<void> {
	let tick = 0;
	const draw = () => launchFrame({ ...input, tick, lift: Math.floor(tick ** 2 / 4) });
	const app = render(draw(), { exitOnCtrlC: true, patchConsole: false });
	await new Promise<void>((done) => {
		const timer = setInterval(() => {
			tick++;
			app.rerender(draw());
			if (tick * BEAT_MS >= SETUP_LIFT_OFF_MS) {
				clearInterval(timer);
				done();
			}
		}, BEAT_MS);
	});
	app.unmount();
}
