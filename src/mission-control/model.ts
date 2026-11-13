/**
 * Mission control's model: what it shows (a snapshot of the project's environments and their logs,
 * read from the supervisor) and what the developer chose to look at (the view), with the pure
 * function that turns a key press into the next view.
 */

import { ofDaemon } from "../layout.ts";

/** A part's state at a glance. `idle`: not running, and the proxy starts it on a first request. */
export type PartState = "running" | "starting" | "failed" | "stopped" | "idle";

/** One app or service of an environment. */
export interface Part {
	/** Its daemon with the supervisor, `<namespace>/<name>`: the key its log lines carry. */
	id: string;
	/** Its key in the config. */
	name: string;
	state: PartState;
	/** Where it is reached: an app's URL, a service's address. */
	address: string;
	/** A detail after the address: an app's port and pid, a service's kind. */
	note?: string;
	/** Why it failed, as the supervisor says (`exit code 1`). */
	error?: string;
}

/** One environment as mission control shows it. */
export interface EnvironmentView {
	/** Its namespace with the supervisor: unique, and what the view selects by. */
	namespace: string;
	/** `main`, or a worktree's suffix. */
	label: string;
	/** Its git branch; none when detached. */
	branch?: string;
	/** Its folder. */
	dir: string;
	apps: Part[];
	/** Its services, which run in main's namespace or, for a server of its own, in its. */
	services: Part[];
	/** Why its parts cannot be shown, such as a config that does not load. */
	problem?: string;
	/** A worktree whose git worktree has changes git would lose: modified, staged or untracked. */
	changes?: boolean;
}

/** One line a part printed. */
export interface LogLine {
	/** Arrival order across every part: a merged stream sorts by it. */
	seq: number;
	/** The part's daemon id. */
	id: string;
	/** `HH:MM:SS`, as the supervisor stamped it. */
	time: string;
	text: string;
}

/** Everything mission control shows, as last read from the supervisor. */
export interface Snapshot {
	/** The project's name. */
	project: string;
	/** Main first, then each worktree. */
	environments: EnvironmentView[];
	/** Each part's recent lines, oldest first, by daemon id. */
	logs: ReadonlyMap<string, readonly LogLine[]>;
	/** Log lines that arrived in the last second. */
	rate: number;
	/** What the view has under way that takes a while: worktrees being added or removed. */
	work?: readonly Work[];
}

/** A worktree being added or removed from the view. */
export interface Work {
	kind: "add" | "remove";
	/** What it is, as the developer sees it: `Adding a worktree`, `Removing shop-1`. */
	title: string;
	/** The last line its command printed. */
	line?: string;
	/** The environment being removed. */
	namespace?: string;
}

/** What the developer is looking at. */
export interface View {
	/** The selected environment's namespace. */
	selected: string;
	/** The one part whose logs are shown; all of the environment's when none. */
	focus?: string;
	/** Set once the developer closes mission control. */
	quit: boolean;
	/** What the last key did or could not do, shown until the next key. */
	notice?: string;
	/** Scrolled back, the stream is paused: the arrival number (`seq`) of the newest line shown. */
	until?: number;
	/** A search of the stream: while `typing`, keys go to the query; after, `until` is its match. */
	search?: { query: string; typing: boolean };
	/** The apps' logs in columns side by side, rather than merged into one stream. */
	sideBySide?: true;
	/**
	 * A worktree's removal waiting for the developer's word: `remove` asks yes or no; `discard`, for
	 * a worktree with uncommitted changes, wants its name typed (`typed`) and enter.
	 */
	confirm?: { namespace: string; suffix: string; step: "remove" | "discard"; typed?: string };
}

/**
 * Something the developer asked of what runs, which the view cannot do itself: `perform` in
 * `act.ts` does it. A part's actions name that part; an environment's name its apps, and main's
 * also its services, as `basepad down` and `up` do.
 */
export type Intent =
	| Action
	| { kind: "open"; url: string }
	| { kind: "copy"; text: string }
	| { kind: "add" }
	| Removal;

/** A worktree's removal, as `basepad worktree rm` does it: `force` loses its uncommitted changes. */
export interface Removal {
	kind: "remove";
	suffix: string;
	namespace: string;
	force: boolean;
}

/** A start, stop or restart of daemons in one namespace. */
export interface Action {
	kind: "start" | "stop" | "restart";
	/** The supervisor namespace the daemons are in. */
	namespace: string;
	/** Apps, which a stop holds so no request starts them again. */
	apps: string[];
	/** Services, which are never held. */
	services: string[];
	/** What the developer sees it called: the part's name, or the environment's label. */
	label: string;
}

/** What a key press did: the next view, and what to ask of what runs, if anything. */
export interface Step {
	view: View;
	intent?: Intent;
}

/** The view mission control opens on: the environment `basepad up` ran in. */
export function initialView(selected: string): View {
	return { selected, quit: false };
}

/** The selected environment: the one the view names, else the first. */
export function selectedOf(snapshot: Snapshot, view: View): EnvironmentView | undefined {
	return (
		snapshot.environments.find((env) => env.namespace === view.selected) ?? snapshot.environments[0]
	);
}

/** An environment's apps, then its services: the order the view lists and steps through them. */
export function partsOf(env: EnvironmentView | undefined): Part[] {
	return env === undefined ? [] : [...env.apps, ...env.services];
}

const ACTIONS: Record<string, { kind: "start" | "stop" | "restart"; doing: string }> = {
	s: { kind: "start", doing: "Starting" },
	x: { kind: "stop", doing: "Stopping" },
	r: { kind: "restart", doing: "Restarting" },
};

/**
 * The parts whose lines the stream shows: side by side, the environment's apps; else the focused
 * part, or all the environment's.
 */
export function streamIds(snapshot: Snapshot, view: View): string[] {
	const env = selectedOf(snapshot, view);
	if (view.sideBySide) return (env?.apps ?? []).map((app) => app.id);
	const parts = partsOf(env);
	const focused = parts.find((part) => part.id === view.focus);
	return focused === undefined ? parts.map((part) => part.id) : [focused.id];
}

/** Every line the stream can show, scrolled all the way back, in arrival order. */
export function streamLines(snapshot: Snapshot, view: View): LogLine[] {
	return streamIds(snapshot, view)
		.flatMap((id) => snapshot.logs.get(id) ?? [])
		.sort((a, b) => a.seq - b.seq);
}

/** The index of the last line that arrived no later than `seq`; -1 when none did. */
function indexOf(lines: readonly LogLine[], seq: number): number {
	let i = lines.length - 1;
	while (i >= 0 && (lines[i] as LogLine).seq > seq) i--;
	return i;
}

/**
 * A key: its name (`up`, `down`, `left`, `right`, `escape`, `ctrl-c`, `pageup`, `pagedown`,
 * `home`, `end`, `return`, `backspace`) or the character typed; or text pasted, which arrives at
 * once.
 */
export type Press = string | { paste: string };

/**
 * The text a press types into a field: a character, or a paste without its control characters (a
 * newline it was copied with, a tab), since a field is one line and a paste never acts; a named
 * key types none.
 */
const textOf = (key: Press): string | undefined =>
	typeof key !== "string"
		? [...key.paste].filter((c) => c >= " " && c !== "\u007f").join("")
		: [...key].length === 1
			? key
			: undefined;

/**
 * What a key press does. `page` is how many log lines the stream shows: a page up or down moves
 * by that many. A paste is text in a text field (the search, a worktree's suffix) and no key
 * anywhere else, so it never starts or stops anything.
 */
export function reduce(previous: View, key: Press, snapshot: Snapshot, page = 10): Step {
	const { notice: _, ...view } = previous;
	if (view.confirm !== undefined) return confirming(view, view.confirm, key, snapshot);
	if (view.search?.typing) return { view: typing(view, view.search.query, key, snapshot) };
	if (typeof key !== "string") return { view: previous };
	const envs = snapshot.environments;
	const env = selectedOf(snapshot, view);
	const at = env === undefined ? 0 : envs.indexOf(env);
	const select = (i: number): View => {
		const next = envs[Math.max(0, Math.min(envs.length - 1, i))];
		if (next === undefined) return view;
		return {
			selected: next.namespace,
			quit: false,
			...(view.sideBySide ? { sideBySide: true } : {}),
		};
	};
	// Focus steps through "all" (none), then each part in order, and round again.
	const step = (by: 1 | -1): View => {
		const ids = [undefined, ...partsOf(env).map((part) => part.id)];
		const now = Math.max(0, ids.indexOf(view.focus));
		const focus = ids[(now + by + ids.length) % ids.length];
		const { focus: _, until: __, ...rest } = view;
		return focus === undefined ? rest : { ...rest, focus };
	};
	// Scrolling pauses the stream at a line, by its arrival, so new lines do not move it.
	const scroll = (by: number | "oldest" | "live"): View => {
		const lines = streamLines(snapshot, view);
		const { until: _, ...live } = view;
		const last = lines.length - 1;
		if (by === "live" || lines.length <= page) return live;
		const now = view.until === undefined ? last : Math.max(page - 1, indexOf(lines, view.until));
		const at = by === "oldest" ? page - 1 : Math.max(page - 1, now + by);
		return at >= last ? live : { ...view, until: (lines[at] as LogLine).seq };
	};
	const focused = partsOf(env).find((part) => part.id === view.focus);
	const action = ACTIONS[key];
	if (action !== undefined) {
		const intent = env === undefined ? undefined : actionOn(env, focused, action.kind);
		if (intent === undefined)
			return { view: { ...view, notice: `Nothing here to ${action.kind}.` } };
		return { view: { ...view, notice: `${action.doing} ${intent.label}…` }, intent };
	}
	// Open and copy take the selected part, else the environment's first app.
	const target = focused ?? env?.apps[0];
	switch (key) {
		case "o":
			if (target === undefined) return { view: { ...view, notice: "Nothing here to open." } };
			if (!env?.apps.includes(target)) {
				const notice = `${target.name} is a service, with no page to open; c copies its address.`;
				return { view: { ...view, notice } };
			}
			return { view, intent: { kind: "open", url: target.address } };
		case "c":
			if (target === undefined) return { view: { ...view, notice: "Nothing here to copy." } };
			return { view, intent: { kind: "copy", text: target.address } };
		case "q":
		case "ctrl-c":
			return { view: { ...view, quit: true } };
		case "up":
		case "k":
			return { view: select(at - 1) };
		case "down":
		case "j":
			return { view: select(at + 1) };
		case "right":
		case "l":
			return { view: step(1) };
		case "left":
		case "h":
			return { view: step(-1) };
		case "pageup":
			return { view: scroll(-page) };
		case "pagedown":
			return { view: scroll(page) };
		case "home":
		case "g":
			return { view: scroll("oldest") };
		case "end":
		case "G":
			return { view: scroll("live") };
		case "v": {
			const { sideBySide, until: _, ...rest } = view;
			return { view: sideBySide ? rest : { ...rest, sideBySide: true } };
		}
		case "a":
			if (snapshot.work?.some((w) => w.kind === "add")) {
				const notice = "A worktree is being added; a adds another once it is made.";
				return { view: { ...view, notice } };
			}
			return { view, intent: { kind: "add" } };
		case "d": {
			if (env === undefined || env === envs[0]) {
				return {
					view: { ...view, notice: "Main is not a worktree: only a worktree is removed here." },
				};
			}
			if (snapshot.work?.some((w) => w.namespace === env.namespace)) {
				return { view: { ...view, notice: `${env.label} is being removed.` } };
			}
			const confirm = { namespace: env.namespace, suffix: env.label, step: "remove" as const };
			return { view: { ...view, confirm } };
		}
		case "/":
			return { view: { ...view, search: { query: "", typing: true } } };
		case "n":
		case "N":
			return {
				view: view.search === undefined ? view : find(view, key === "n" ? -1 : 1, snapshot),
			};
		case "escape": {
			// One layer at a time: the search or the pause, then the focus.
			const { until, search, ...rest } = view;
			if (until !== undefined || search !== undefined) return { view: rest };
			const { focus: _, ...all } = rest;
			return { view: all };
		}
		default:
			return { view };
	}
}

/**
 * A key while a worktree's removal waits for the developer's word. Only `y` goes on, and for a
 * worktree with uncommitted changes only its name typed out; any other key keeps it.
 */
function confirming(
	view: View,
	confirm: NonNullable<View["confirm"]>,
	key: Press,
	snapshot: Snapshot,
): Step {
	const { confirm: _, ...rest } = view;
	const { namespace, suffix } = confirm;
	const env = snapshot.environments.find((e) => e.namespace === namespace);
	if (key === "ctrl-c") return { view: { ...rest, quit: true } };
	if (env === undefined) return { view: rest };
	const removal = (force: boolean): Step => ({
		view: rest,
		intent: { kind: "remove", suffix, namespace, force },
	});
	const kept = (why = "") => ({ view: { ...rest, notice: `Kept ${suffix}${why}.` } });
	if (confirm.step === "remove") {
		if (typeof key !== "string") return { view };
		if (key !== "y") return kept();
		if (!env.changes) return removal(false);
		return { view: { ...rest, confirm: { ...confirm, step: "discard", typed: "" } } };
	}
	const typed = confirm.typed ?? "";
	switch (key) {
		case "return":
			return typed === suffix ? removal(true) : kept(`: the name typed was not ${suffix}`);
		case "escape":
			return kept();
		case "backspace":
			return {
				view: { ...view, confirm: { ...confirm, typed: [...typed].slice(0, -1).join("") } },
			};
		default: {
			// A named key (an arrow, page up) is not text.
			const text = textOf(key);
			return text === undefined
				? { view }
				: { view: { ...view, confirm: { ...confirm, typed: typed + text } } };
		}
	}
}

/** A key while a search is typed: text, or `return` to search, or `escape` to cancel. */
function typing(view: View, query: string, key: Press, snapshot: Snapshot): View {
	const { search: _, ...rest } = view;
	switch (key) {
		case "ctrl-c":
			return { ...view, quit: true };
		case "escape":
			return rest;
		case "backspace":
			return { ...view, search: { query: [...query].slice(0, -1).join(""), typing: true } };
		case "return": {
			if (query === "") return rest;
			const { until: __, ...live } = rest;
			const found = find({ ...live, search: { query, typing: false } }, -1, snapshot);
			return found.until === undefined ? { ...live, notice: `No line matches “${query}”.` } : found;
		}
		default: {
			// A named key (an arrow, page up) is not text.
			const text = textOf(key);
			return text === undefined ? view : { ...view, search: { query: query + text, typing: true } };
		}
	}
}

/**
 * The view at the next line that matches the search, ignoring case: older (`-1`) or newer (`1`)
 * than the one shown, or the newest when live.
 */
function find(view: View, by: -1 | 1, snapshot: Snapshot): View {
	const query = view.search?.query.toLowerCase() ?? "";
	const lines = streamLines(snapshot, view);
	const from = view.until === undefined ? lines.length : indexOf(lines, view.until);
	for (let i = from + by; i >= 0 && i < lines.length; i += by) {
		const line = lines[i] as LogLine;
		if (line.text.toLowerCase().includes(query)) return { ...view, until: line.seq };
	}
	const which = by < 0 ? "older" : "newer";
	return { ...view, notice: `No ${which} line matches “${view.search?.query}”.` };
}

/** A start, stop or restart of one part, or of the whole environment when none is given. */
function actionOn(
	env: EnvironmentView,
	part: Part | undefined,
	kind: Action["kind"],
): Action | undefined {
	if (part !== undefined) {
		const isApp = env.apps.includes(part);
		return {
			kind,
			namespace: ofDaemon(part.id).namespace,
			apps: isApp ? [part.name] : [],
			services: isApp ? [] : [part.name],
			label: part.name,
		};
	}
	// A worktree's services on main's servers are main's: only main's own actions reach them.
	const services = env.services.filter((s) => ofDaemon(s.id).namespace === env.namespace);
	if (env.apps.length + services.length === 0) return undefined;
	return {
		kind,
		namespace: env.namespace,
		apps: env.apps.map((a) => a.name),
		services: services.map((s) => s.name),
		label: env.label,
	};
}
