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

/**
 * The next view after a key press. `key` is a name (`up`, `down`, `left`, `right`, `escape`,
 * `ctrl-c`) or the character typed.
 */
export function reduce(view: View, key: string, snapshot: Snapshot): View {
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
		const { focus: _, ...rest } = view;
		return focus === undefined ? rest : { ...rest, focus };
	};
	switch (key) {
		case "q":
		case "ctrl-c":
			return { ...view, quit: true };
		case "up":
		case "k":
			return select(at - 1);
		case "down":
		case "j":
			return select(at + 1);
		case "right":
		case "l":
			return step(1);
		case "left":
		case "h":
			return step(-1);
		case "escape":
			return { selected: view.selected, quit: view.quit };
		default:
			return view;
	}
}
