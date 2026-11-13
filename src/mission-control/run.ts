import { type Key, render, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, useEffect, useRef, useState } from "react";
import type { Project } from "../config.ts";
import type { Machine } from "../layout.ts";
import type { Supervisor } from "../supervisor.ts";
import { desktopHands, type Hands, perform } from "./act.ts";
import { type Feed, openFeed } from "./feed.ts";
import { frame, pageOf } from "./frame.ts";
import { initialView, reduce } from "./model.ts";

/**
 * Mission control on the developer's terminal: full screen, redrawn as the feed changes, keys
 * through the reducer. The one adapter to terminal input and output. Resolves once the developer
 * closes it, with the terminal restored; it only ever read, so everything keeps running.
 */
export async function missionControl(options: {
	main: Project;
	machine: Machine;
	supervisor: Supervisor;
	/** The namespace of the environment to open on: the one `up` ran in. */
	selected: string;
}): Promise<void> {
	const listeners = new Set<() => void>();
	const feed = await openFeed({
		...options,
		changed: () => {
			for (const listener of listeners) listener();
		},
	});
	const app = render(
		h(App, {
			feed,
			hands: desktopHands(options.supervisor, process.stdout),
			listeners,
			selected: options.selected,
			// NO_COLOR, set to anything but empty, turns colour off (https://no-color.org).
			color: !process.env.NO_COLOR,
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
	color: boolean;
}) {
	const { feed, hands, listeners, color } = props;
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [view, setView] = useState(() => initialView(props.selected));
	// The latest view, so keys that arrive before a repaint (a paste into search) each build on it.
	const latest = useRef(view);
	latest.current = view;
	const [, setTick] = useState(0);
	useEffect(() => {
		const repaint = () => setTick((n) => n + 1);
		listeners.add(repaint);
		// The clock.
		const timer = setInterval(repaint, 1000);
		return () => {
			listeners.delete(repaint);
			clearInterval(timer);
		};
	}, [listeners]);
	const snapshot = feed.snapshot();
	useInput((input, key) => {
		const name = keyName(input, key);
		// Text pasted into a search arrives at once: each character is a key. Elsewhere a paste is
		// no key, so it never starts or stops anything.
		const typing = latest.current.search?.typing === true;
		const pasted = name === input && [...input].length > 1;
		for (const one of pasted && typing ? [...input] : [name]) {
			const now = latest.current;
			const page = pageOf(snapshot, now, columns, rows);
			const { view: next, intent } = reduce(now, one, snapshot, page);
			if (next.quit) {
				exit();
				return;
			}
			latest.current = next;
			setView(next);
			if (intent === undefined) continue;
			// Done in the background, so the view stays live; the outcome shows when it is known.
			perform(intent, hands).then((notice) => {
				feed.refresh();
				setView((then) => ({ ...then, notice }));
			});
		}
	});
	return frame({ snapshot, view, cols: columns, rows, now: clock(), color });
}

/** A key press as the reducer names it. */
function keyName(input: string, key: Key): string {
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
	return input;
}

/** The time, `HH:MM:SS`. */
function clock(): string {
	return new Date().toTimeString().slice(0, 8);
}
