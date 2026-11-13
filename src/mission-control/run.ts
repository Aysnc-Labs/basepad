import chalk from "chalk";
import { type Key, render, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, useEffect, useRef, useState } from "react";
import type { Project } from "../config.ts";
import { type Machine, workHome } from "../layout.ts";
import type { Supervisor } from "../supervisor.ts";
import { desktopHands, type Hands, perform } from "./act.ts";
import { type Feed, openFeed } from "./feed.ts";
import {
	animating,
	type Colors,
	colorsFor,
	frame,
	NOTICE_FADE_MS,
	NOTICE_MS,
	pageOf,
} from "./frame.ts";
import {
	type Intent,
	initialView,
	type PartState,
	type Press,
	reduce,
	type Snapshot,
} from "./model.ts";
import { startWork } from "./work.ts";

/**
 * Mission control on the developer's terminal: full screen, redrawn as the feed changes, keys
 * through the reducer. The one adapter to terminal input and output. Resolves once the developer
 * closes it, with the terminal restored; it only ever read, so everything keeps running, a
 * worktree being added or removed too.
 */
export async function missionControl(options: {
	main: Project;
	/** The machine as served now: whether URLs are port-free is known once the supervisor runs. */
	machine(): Machine;
	supervisor: Supervisor;
	/** What went wrong readying the environment meanwhile, if anything yet: told once, as a notice. */
	failure?: () => string | undefined;
	/** The namespace of the environment to open on: the one `up` ran in. */
	selected: string;
	/** The `basepad` command, as argv: what adds and removes a worktree, in a process of its own. */
	basepad: string[];
}): Promise<void> {
	const { main, basepad } = options;
	const listeners = new Set<() => void>();
	const work = workHome(options.machine(), main.name);
	const feed = await openFeed({
		...options,
		work,
		changed: () => {
			for (const listener of listeners) listener();
		},
	});
	// From main, as `basepad worktree add` and `rm` there.
	const worktrees: Hands["worktrees"] = (order) =>
		startWork({
			dir: work,
			command: basepad,
			cwd: main.root,
			order,
			...(order.kind === "add"
				? {
						before: feed
							.snapshot()
							.environments.slice(1)
							.map((env) => env.label),
					}
				: {}),
		});
	const app = render(
		h(App, {
			feed,
			hands: desktopHands(options.supervisor, worktrees, process.stdout),
			listeners,
			failure: options.failure,
			selected: options.selected,
			color: colorsFor(process.env.NO_COLOR, chalk.level),
		}),
		{
			alternateScreen: true,
			// Ctrl-C goes through the reducer, as `q` does.
			exitOnCtrlC: false,
			maxFps: 20,
			incrementalRendering: true,
		},
	);
	try {
		await app.waitUntilExit();
	} finally {
		feed.close();
	}
}

/** The live view's one component: the frame for the feed's latest snapshot and the view. */
function App(props: {
	feed: Feed;
	hands: Hands;
	listeners: Set<() => void>;
	failure: (() => string | undefined) | undefined;
	selected: string;
	color: Colors;
}) {
	const { feed, hands, listeners, color, failure } = props;
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [view, setView] = useState(() => initialView(props.selected));
	// The latest view, so keys that arrive before a repaint each build on it.
	const latest = useRef(view);
	latest.current = view;
	const [, setTick] = useState(0);
	const motion = useRef(motionBook());
	useEffect(() => {
		const repaint = () => {
			// How a worktree's addition or removal ended, even one started before the view opened.
			const told = feed.notices();
			const failed = failure?.();
			if (failed !== undefined) told.push(failed);
			if (told.length > 0) setView((then) => ({ ...then, notice: told.join("  ") }));
			setTick((n) => n + 1);
		};
		listeners.add(repaint);
		// Fast while anything moves; else each second, for the clock. A notice goes once faded.
		let second = Math.floor(Date.now() / 1000);
		const timer = setInterval(() => {
			const now = Date.now();
			const { notice } = latest.current;
			if (
				notice !== undefined &&
				motion.current.noticeAge(notice, now) >= NOTICE_MS + NOTICE_FADE_MS
			) {
				setView((then) => (then.notice === notice ? { ...then, notice: undefined } : then));
			}
			const moving = animating({
				snapshot: feed.snapshot(),
				clock: now,
				changed: motion.current.changed,
				noticeAge: notice === undefined ? undefined : motion.current.noticeAge(notice, now),
			});
			if (moving || Math.floor(now / 1000) !== second) {
				second = Math.floor(now / 1000);
				setTick((n) => n + 1);
			}
		}, FRAME_MS);
		return () => {
			listeners.delete(repaint);
			clearInterval(timer);
		};
	}, [listeners, feed, failure]);
	const snapshot = feed.snapshot();
	const now = Date.now();
	motion.current.see(snapshot, now);
	/** Does an intent in the background, so the view stays live; its outcome shows when known. */
	const act = (intent: Intent) => {
		perform(intent, hands).then((notice) => {
			feed.refresh();
			setView((then) => ({ ...then, notice }));
		});
	};
	useInput((input, key) => {
		const now = latest.current;
		const page = pageOf(snapshot, now, columns, rows);
		const { view: next, intent } = reduce(now, pressOf(input, key), snapshot, page);
		if (next.quit) {
			exit();
			return;
		}
		latest.current = next;
		setView(next);
		if (intent !== undefined) act(intent);
	});
	return frame({
		snapshot,
		view,
		cols: columns,
		rows,
		now: clock(),
		color,
		clock: now,
		changed: motion.current.changed,
		...(view.notice === undefined ? {} : { noticeAge: motion.current.noticeAge(view.notice, now) }),
	});
}

/** A frame's time while anything moves: about twelve a second. */
const FRAME_MS = 80;

/**
 * What the view's motion remembers between frames: when each part last changed state (the first
 * read is where they start, not a change), and when the notice now shown first showed.
 */
function motionBook() {
	const states = new Map<string, PartState>();
	const changed = new Map<string, number>();
	let notice: { text: string; at: number } | undefined;
	return {
		changed,
		see(snapshot: Snapshot, now: number) {
			for (const env of snapshot.environments) {
				for (const part of [...env.apps, ...env.services]) {
					const was = states.get(part.id);
					if (was !== undefined && was !== part.state) changed.set(part.id, now);
					states.set(part.id, part.state);
				}
			}
		},
		noticeAge(text: string, now: number) {
			if (notice?.text !== text) notice = { text, at: now };
			return now - notice.at;
		},
	};
}

/** A key press as the reducer names it; text that arrives at once is a paste. */
export function pressOf(input: string, key: Key): Press {
	if (key.ctrl && input === "c") return "ctrl-c";
	if (key.tab) return key.shift ? "shift-tab" : "tab";
	if (input === " ") return "space";
	if (key.upArrow) return "up";
	if (key.downArrow) return "down";
	if (key.leftArrow) return "left";
	if (key.rightArrow) return "right";
	if (key.escape) return "escape";
	if (key.pageUp) return "pageup";
	if (key.pageDown) return "pagedown";
	if (key.home) return "home";
	if (key.end) return "end";
	if (key.return) return "return";
	if (key.backspace || key.delete) return "backspace";
	return [...input].length > 1 ? { paste: input } : input;
}

/** The time, `HH:MM:SS`. */
function clock(): string {
	return new Date().toTimeString().slice(0, 8);
}
