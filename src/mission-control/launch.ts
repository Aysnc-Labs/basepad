import { Box, render, Text } from "ink";
import { createElement as h, type ReactElement } from "react";
import { type Colors, type Palette, palette } from "./frame.ts";

/**
 * The launch and the landing, drawn on a terminal. The launch is `setup`'s: its plan as a checklist
 * beside a rocket on its pad, which lifts off once every step is done; a failed step is no-go, and
 * the rocket stays down. The landing is `down`'s: a capsule splashing down as everything stops.
 * Pure frames, and the live views that animate them.
 */
export interface Check {
	name: string;
	state: "waiting" | "active" | "go" | "nogo";
}

export interface LaunchInput {
	/** What launches: `SETUP` beside `BASEPAD`. */
	title: string;
	/** Under the title: the machine, or the project and environment. */
	subtitle: string;
	checks: Check[];
	/** The animation's beat, a tenth of a second each: the flame flickers, the beacon blinks. */
	tick: number;
	/** How far the rocket has risen, in pixels; 0 on the pad. */
	lift: number;
	/** Seconds since the launch began; none, no clock. */
	elapsed?: number;
	/** The last thing a step said, such as a database being copied. */
	note?: string;
	cols: number;
	/** The rows it has; the rocket shows only where it fits. */
	rows?: number;
	color: Colors;
}

const withArt = ({ cols, rows, color }: LaunchInput) =>
	color === "rgb" && cols >= ART_COLS && (rows ?? Number.POSITIVE_INFINITY) >= MIN_ART_ROWS + 2;

/** The rows the art takes in `rows` with its padding: the whole sky where it fits, less above. */
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

/** The art, if any, with the checklist to its right. */
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

// ── the checklist ─────────────────────────────────────────────────────────────────────────────

/** The art needs this many columns beside the checklist, this many rows, and a colour per pixel. */
const ART_COLS = 70;
const ART_ROWS = 18;
/** The least it shows: the rocket, its tower and pad, with the sky above cut. */
const MIN_ART_ROWS = 13;
const WIDTH = 34;

/** A line of status: its words and their colour. */
type Said = [string, string | undefined];

interface List {
	title: string;
	subtitle: string;
	checks: Check[];
	/** What a check that went well says. */
	lamp: string;
	status: Said;
	clock?: string;
	note?: string;
}

function checklist(list: List, c: Palette): ReactElement {
	const rule = h(Text, { color: c.dim }, "─".repeat(WIDTH));
	// Dark type on a lit lamp; without colour, the terminal's own.
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

// ── the rocket ────────────────────────────────────────────────────────────────────────────────

/** A Saturn-style rocket, a character per pixel: each letter a colour (`colours`), `.` none. */
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

/** A blank sky, `put` to draw a pixel into it, and `stamp` to draw rows of them. */
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
/** Where the tower's beacon blinks. */
const BEACON: [number, number] = [5, TOWER_TOP - 2];

/** The stars, the tower (its beacon dark, its arms away from the rocket) and the pad. */
function ground(put: (x: number, y: number, ch: string) => void, armsIn: boolean) {
	for (const [x, y] of STARS) put(x, y, "*");
	// The umbilical tower: two legs and a lattice.
	for (let y = TOWER_TOP; y < PAD; y++) {
		put(3, y, "T");
		put(7, y, "T");
		put(4 + ((y - TOWER_TOP) % 3), y, "t");
	}
	put(5, TOWER_TOP - 1, "T");
	put(...BEACON, "t");
	// Its arms hold the rocket until it is cleared to go.
	for (const y of [ROCKET_TOP + 4, ROCKET_TOP + 10, ROCKET_TOP + 16])
		for (let x = 8; x < (armsIn ? ROCKET_X + 2 : 10); x++) put(x, y, "T");
	for (let x = 0; x < WIDE; x++) put(x, PAD, "D");
	for (let x = 1; x < WIDE - 1; x++) put(x, PAD + 1, x > 10 && x < 22 ? "K" : "D");
}

/** The pad as pixels, a row of letters each: the tower, the rocket risen `lift`, its flame. */
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

/**
 * The art in layers, for drawing it elsewhere (the README's rocket, `scripts/rocket-svg.ts`): the
 * ground with the tower's arms away, the rocket and its flames as stamped at `x`, `top`, and each
 * letter's colour.
 */
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

/** Two pixel rows to a line of text: `▀` in the top one's colour, on the bottom one's. */
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

// ── the landing ───────────────────────────────────────────────────────────────────────────────

/**
 * The landing: what `down` shows on a terminal while it stops an environment. Its apps and services
 * listed beside a capsule coming down under its parachute, which splashes down once they stop.
 */
export interface LandingInput {
	project: string;
	environment: string;
	/** What stops: the apps, and the services in main. */
	parts: string[];
	state: "stopping" | "stopped" | "failed";
	tick: number;
	/** How far the capsule has come down, in pixels. */
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
	const worktree = input.environment !== "main";
	const note =
		input.state !== "stopped"
			? undefined
			: worktree
				? "Its services are main's and keep running. `basepad up` relaunches."
				: "`basepad up` relaunches.";
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

/** The capsule's parachute, its gores red and white. */
const CHUTE = [
	"......RRWWRR......",
	"...RRWWRRWWRRWW...",
	"..WWRRWWRRWWRRWW..",
	".RRWWRRWWRRWWRRWW.",
	"RRWWRRWWRRWWRRWWRR",
	"t.......t........t",
];
const CAPSULE = ["...W...", "..WWw..", ".WWWWw.", "WWWWWww", "DDDDDDD"];

/** The sky and sea as pixels: the capsule under its chute `drop` down, swaying, then splashed. */
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
	// The lowest it comes before landing, and where it floats after.
	const lowest = sea - CAPSULE.length - CHUTE.length - 7;
	const y = down ? sea - CAPSULE.length - CHUTE.length - 5 : Math.min(lowest, drop);
	const sway = down ? 0 : tick % 20 < 10 ? 0 : 1;
	const x = 4 + sway;
	if (!down) {
		stamp(CHUTE, x, y);
		// Shroud lines from the chute's edge and middle to the capsule's top.
		for (let i = 1; i <= 5; i++) {
			const row = y + CHUTE.length - 1 + i;
			put(x + 1 + Math.round((i * 7) / 5), row, "t");
			put(x + 16 - Math.round((i * 6) / 5), row, "t");
			put(x + 9, row, "t");
		}
	}
	const capsuleY = down ? sea - CAPSULE.length + 1 : y + CHUTE.length + 5;
	stamp(CAPSULE, x + 6, capsuleY);
	// The sea, its waves rolling with the beat; a splash once it is down.
	for (let row = sea; row < TALL; row++)
		for (let col = 0; col < WIDE; col++) put(col, row, (col + tick + row) % 4 === 0 ? "w" : "B");
	if (down) for (const dx of [-1, 7, -2, 8]) put(x + 6 + dx, sea - 1 - (Math.abs(dx) % 2), "w");
	return px.map((row) => row.join(""));
}

// ── the live view ─────────────────────────────────────────────────────────────────────────────

/** A beat of the animation. */
const BEAT_MS = 100;

/** How long the splashdown shows before `down` returns. */
const SPLASH_MS = 300;

export interface Landing {
	/** Everything stopped: it splashes down; settles once shown, with the view closed. */
	land(): Promise<void>;
	/** The stop failed: its lamps stay no-go on the terminal. */
	fail(): void;
}

/** Draws the landing on the terminal, in place, until it lands or fails. */
export function landing(options: {
	project: string;
	environment: string;
	parts: string[];
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

/** How long setup's lift-off plays. */
const SETUP_LIFT_OFF_MS = 1500;

/**
 * Plays the lift-off on the terminal, in place, then leaves the empty pad: setup's last moment,
 * once every step is done.
 */
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
