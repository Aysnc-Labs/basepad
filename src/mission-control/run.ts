import chalk from "chalk";
import { type Key, render, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, useEffect, useRef, useState } from "react";
import type { Project } from "../config.ts";
import { type Machine, workHome } from "../layout.ts";
import type { Supervisor } from "../supervisor.ts";
import { desktopHands, type Hands, perform } from "./act.ts";
import { type Feed, openFeed } from "./feed.ts";
import { type Colors, colorsFor, frame, pageOf } from "./frame.ts";
import { type Intent, initialView, type Press, reduce } from "./model.ts";
import { startWork } from "./work.ts";

/**
 * Mission control on the developer's terminal: full screen, redrawn as the feed changes, keys
 * through the reducer. The one adapter to terminal input and output. Resolves once the developer
 * closes it, with the terminal restored; it only ever read, so everything keeps running, a
 * worktree being added or removed too.
 */
export async function missionControl(options: {
	main: Project;
	machine: Machine;
	supervisor: Supervisor;
	/** The namespace of the environment to open on: the one `up` ran in. */
	selected: string;
	/** The `basepad` command, as argv: what adds and removes a worktree, in a process of its own. */
	basepad: string[];
}): Promise<void> {
	const { main, machine, basepad } = options;
	const listeners = new Set<() => void>();
	const work = workHome(machine, main.name);
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
	selected: string;
	color: Colors;
}) {
	const { feed, hands, listeners, color } = props;
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [view, setView] = useState(() => initialView(props.selected));
	// The latest view, so keys that arrive before a repaint each build on it.
	const latest = useRef(view);
	latest.current = view;
	const [, setTick] = useState(0);
	useEffect(() => {
		const repaint = () => {
			// How a worktree's addition or removal ended, even one started before the view opened.
			const told = feed.notices();
			if (told.length > 0) setView((then) => ({ ...then, notice: told.join("  ") }));
			setTick((n) => n + 1);
		};
		listeners.add(repaint);
		// The clock.
		const timer = setInterval(repaint, 1000);
		return () => {
			listeners.delete(repaint);
			clearInterval(timer);
		};
	}, [listeners, feed]);
	const snapshot = feed.snapshot();
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
	return frame({ snapshot, view, cols: columns, rows, now: clock(), color });
}

/** A key press as the reducer names it; text that arrives at once is a paste. */
function pressOf(input: string, key: Key): Press {
	if (key.ctrl && input === "c") return "ctrl-c";
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
