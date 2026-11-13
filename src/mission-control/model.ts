/**
 * Mission control's model: what it shows (a snapshot of the project's environments and their logs,
 * read from the supervisor) and what the developer chose to look at (the view), with the pure
 * function that turns a key press into the next view.
 */

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
	/** Its services, which run in main's namespace. */
	services: Part[];
	/** Why its parts cannot be shown, such as a config that does not load. */
	problem?: string;
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
}

/**
 * Something the developer asked of what runs, which the view cannot do itself: `perform` in
 * `act.ts` does it. A part's actions name that part; an environment's name its apps, and main's
 * also its services, as `basepad down` and `up` do.
 */
export type Intent = Action | { kind: "open"; url: string } | { kind: "copy"; text: string };

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

/** The parts whose lines the stream shows: the focused one, else all the environment's. */
export function streamIds(snapshot: Snapshot, view: View): string[] {
	const parts = partsOf(selectedOf(snapshot, view));
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
 * What a key press does. `key` is a name (`up`, `down`, `left`, `right`, `escape`, `ctrl-c`,
 * `pageup`, `pagedown`, `home`, `end`) or the character typed. `page` is how many log lines the
 * stream shows: a page up or down moves by that many.
 */
export function reduce(previous: View, key: string, snapshot: Snapshot, page = 10): Step {
	const { notice: _, ...view } = previous;
	const envs = snapshot.environments;
	const env = selectedOf(snapshot, view);
	const at = env === undefined ? 0 : envs.indexOf(env);
	const select = (i: number): View => {
		const next = envs[Math.max(0, Math.min(envs.length - 1, i))];
		return next === undefined ? view : { selected: next.namespace, quit: false };
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
		case "escape":
			return { view: { selected: view.selected, quit: view.quit } };
		default:
			return { view };
	}
}

/** A start, stop or restart of one part, or of the whole environment when none is given. */
function actionOn(
	env: EnvironmentView,
	part: Part | undefined,
	kind: Action["kind"],
): Action | undefined {
	if (part !== undefined) {
		const slash = part.id.lastIndexOf("/");
		const isApp = env.apps.includes(part);
		return {
			kind,
			namespace: part.id.slice(0, slash),
			apps: isApp ? [part.name] : [],
			services: isApp ? [] : [part.name],
			label: part.name,
		};
	}
	// A worktree's services are main's: only main's own actions reach them.
	const services = env.services.filter((s) => s.id.startsWith(`${env.namespace}/`));
	if (env.apps.length + services.length === 0) return undefined;
	return {
		kind,
		namespace: env.namespace,
		apps: env.apps.map((a) => a.name),
		services: services.map((s) => s.name),
		label: env.label,
	};
}
