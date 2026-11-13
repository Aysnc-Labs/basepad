import { type Key, render, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, useEffect, useState } from "react";
import type { Project } from "../config.ts";
import type { Machine } from "../layout.ts";
import type { Supervisor } from "../supervisor.ts";
import { type Feed, openFeed } from "./feed.ts";
import { frame } from "./frame.ts";
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
function App(props: { feed: Feed; listeners: Set<() => void>; selected: string; color: boolean }) {
	const { feed, listeners, color } = props;
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const [view, setView] = useState(() => initialView(props.selected));
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
		const next = reduce(view, keyName(input, key), snapshot);
		if (next.quit) exit();
		else setView(next);
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
	return input;
}

/** The time, `HH:MM:SS`. */
function clock(): string {
	return new Date().toTimeString().slice(0, 8);
}
