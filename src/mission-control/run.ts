import chalk from "chalk";
import { type Key, render, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, useEffect, useRef, useState } from "react";
import type { Project } from "../config.ts";
import type { Machine } from "../layout.ts";
import type { Supervisor } from "../supervisor.ts";
import { desktopHands, type Hands, perform } from "./act.ts";
import { type Feed, openFeed } from "./feed.ts";
import { type Colors, colorsFor, frame, pageOf } from "./frame.ts";
import { type Intent, initialView, reduce, type Work } from "./model.ts";

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
	/** `basepad worktree add` and `rm`, run from main. */
	worktrees: Hands["worktrees"];
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
			hands: desktopHands(options.supervisor, options.worktrees, process.stdout),
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
	// Worktrees being added or removed, by a number of their own: each with its command's last line.
	const jobs = useRef(new Map<number, Work>());
	const jobCount = useRef(0);
	const work = [...jobs.current.values()];
	const snapshot = { ...feed.snapshot(), work };
	/** Does an intent in the background, so the view stays live; its outcome shows when known. */
	const act = (intent: Intent) => {
		if (intent.kind !== "add" && intent.kind !== "remove") {
			perform(intent, hands).then((notice) => {
				feed.refresh();
				setView((then) => ({ ...then, notice }));
			});
			return;
		}
		const item: Work =
			intent.kind === "add"
				? { kind: "add", title: "Adding a worktree" }
				: { kind: "remove", title: `Removing ${intent.suffix}`, namespace: intent.namespace };
		// A worktree being added shows once it is made, not while its databases and setup are.
		const release = intent.kind === "add" ? feed.adding() : () => {};
		const id = jobCount.current++;
		jobs.current.set(id, item);
		setTick((n) => n + 1);
		perform(intent, hands, (line) => {
			jobs.current.set(id, { ...item, line });
			setTick((n) => n + 1);
		}).then((notice) => {
			release();
			jobs.current.delete(id);
			feed.refresh();
			setView((then) => ({ ...then, notice }));
		});
	};
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
			if (intent !== undefined) act(intent);
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
