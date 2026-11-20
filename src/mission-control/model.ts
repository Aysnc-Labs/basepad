import { daemonId, ofDaemon } from "../layout.ts";

export type PartState = "running" | "starting" | "failed" | "stopped" | "idle";

export interface Part {
	id: string;
	name: string;
	state: PartState;
	address?: string;
	note?: string;
	error?: string;
	extraDaemons?: string[];
}

export interface EnvironmentView {
	namespace: string;
	label: string;
	branch?: string;
	dir: string;
	apps: Part[];
	services: Part[];
	problem?: string;
	changes?: boolean;
}

export interface LogLine {
	seq: number;
	id: string;
	time: string;
	text: string;
	at?: number;
}

export interface Snapshot {
	project: string;
	environments: EnvironmentView[];
	logs: ReadonlyMap<string, readonly LogLine[]>;
	rate: number;
	work?: readonly Work[];
}

export interface Work {
	kind: "add" | "remove";
	title: string;
	line?: string;
	namespace?: string;
}

export interface View {
	selected: string;
	focus?: string;
	quit: boolean;
	notice?: string;
	until?: number;
	search?: { query: string; typing: boolean };
	help?: true;
	confirm?: { namespace: string; suffix: string; step: "remove" | "discard"; typed?: string };
}

export type Intent =
	| Action
	| { kind: "open"; url: string }
	| { kind: "copy"; text: string }
	| { kind: "add" }
	| Removal;

export interface Removal {
	kind: "remove";
	suffix: string;
	namespace: string;
	force: boolean;
}

export interface Action {
	kind: "start" | "stop" | "restart";
	namespace: string;
	apps: string[];
	services: string[];
	label: string;
}

export interface Step {
	view: View;
	intent?: Intent;
}

export function initialView(selected: string): View {
	return { selected, quit: false };
}

export function selectedOf(snapshot: Snapshot, view: View): EnvironmentView | undefined {
	return (
		snapshot.environments.find((env) => env.namespace === view.selected) ?? snapshot.environments[0]
	);
}

export function partsOf(env: EnvironmentView | undefined): Part[] {
	return env === undefined ? [] : [...env.apps, ...env.services];
}

const DOING: Record<Action["kind"], string> = {
	start: "Starting",
	stop: "Stopping",
	restart: "Restarting",
};

function toggleOf(env: EnvironmentView, part: Part | undefined): "start" | "stop" {
	const states = part === undefined ? env.apps.map((app) => app.state) : [part.state];
	return states.some((state) => state === "running" || state === "starting") ? "stop" : "start";
}

export function streamIds(snapshot: Snapshot, view: View): string[] {
	const env = selectedOf(snapshot, view);
	const parts = partsOf(env);
	const focused = parts.find((part) => part.id === view.focus);
	if (focused !== undefined) return [focused.id];
	return env === undefined ? [] : [...parts.map((part) => part.id), hooksId(env.namespace)];
}

export const hooksId = (namespace: string): string => daemonId(namespace, "hooks");

export function streamLines(snapshot: Snapshot, view: View): LogLine[] {
	return streamIds(snapshot, view)
		.flatMap((id) => (snapshot.logs.get(id) ?? []).filter(printed))
		.sort((a, b) => a.seq - b.seq);
}

const isPage = (address: string): boolean => /^https?:\/\//.test(address);
export const printed = (line: LogLine) => line.text.trim() !== "";

function indexOf(lines: readonly LogLine[], seq: number): number {
	let i = lines.length - 1;
	while (i >= 0 && (lines[i] as LogLine).seq > seq) i--;
	return i;
}

export type Press = string | { paste: string };

const textOf = (key: Press): string | undefined =>
	typeof key !== "string"
		? [...key.paste].filter((c) => c >= " " && c !== "\u007f").join("")
		: [...key].length === 1
			? key
			: undefined;

export function reduce(previous: View, key: Press, snapshot: Snapshot, page = 10): Step {
	const { notice: _, ...view } = previous;
	if (view.confirm !== undefined) return confirming(view, view.confirm, key, snapshot);
	if (view.search?.typing) return { view: typing(view, view.search.query, key, snapshot) };
	if (typeof key !== "string") return { view: previous };
	const envs = snapshot.environments;
	const env = selectedOf(snapshot, view);
	const at = env === undefined ? 0 : envs.indexOf(env);
	const select = (i: number): View => {
		const next = envs[i];
		if (next === undefined) return view;
		return { selected: next.namespace, quit: false, ...(view.help ? { help: true } : {}) };
	};
	const turn = (by: 1 | -1) => select((at + by + envs.length) % Math.max(1, envs.length));
	const step = (by: 1 | -1): View => {
		const ids = [undefined, ...partsOf(env).map((part) => part.id)];
		const now = Math.max(0, ids.indexOf(view.focus));
		const focus = ids[Math.max(0, Math.min(ids.length - 1, now + by))];
		const { focus: _, until: __, ...rest } = view;
		return focus === undefined ? rest : { ...rest, focus };
	};
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
	if (key === "space" && focused === undefined) {
		const notice = "Select an app or service first (↓); `basepad down` stops them all.";
		return { view: { ...view, notice } };
	}
	const kind =
		key === "r"
			? "restart"
			: key === "space" && env !== undefined
				? toggleOf(env, focused)
				: undefined;
	if (kind !== undefined) {
		const intent = env === undefined ? undefined : actionOn(env, focused, kind);
		if (intent === undefined) return { view: { ...view, notice: `Nothing here to ${kind}.` } };
		return { view: { ...view, notice: `${DOING[kind]} ${intent.label}…` }, intent };
	}
	if (/^[1-9]$/.test(key)) return { view: select(Number(key) - 1) };
	const target = focused ?? env?.apps.find((app) => app.address !== undefined);
	const noAddress = `${target?.name} has no domain, so no address to open or copy.`;
	switch (key) {
		case "return":
			if (target === undefined) return { view: { ...view, notice: "Nothing here to open." } };
			if (target.address === undefined) return { view: { ...view, notice: noAddress } };
			if (!isPage(target.address)) {
				const notice = `${target.name} is a service, with no page to open; c copies its address.`;
				return { view: { ...view, notice } };
			}
			return { view, intent: { kind: "open", url: target.address } };
		case "c":
			if (target === undefined) return { view: { ...view, notice: "Nothing here to copy." } };
			if (target.address === undefined) return { view: { ...view, notice: noAddress } };
			return { view, intent: { kind: "copy", text: target.address } };
		case "q":
		case "ctrl-c":
			return { view: { ...view, quit: true } };
		case "up":
		case "k":
			return { view: step(-1) };
		case "down":
		case "j":
			return { view: step(1) };
		case "tab":
		case "right":
		case "l":
			return { view: turn(1) };
		case "shift-tab":
		case "left":
		case "h":
			return { view: turn(-1) };
		case "?": {
			const { help, ...rest } = view;
			return { view: help ? rest : { ...rest, help: true } };
		}
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
			if (view.help) {
				const { help: _, ...rest } = view;
				return { view: rest };
			}
			const { until, search, ...rest } = view;
			if (until !== undefined || search !== undefined) return { view: rest };
			const { focus: _, ...all } = rest;
			return { view: all };
		}
		default:
			return { view };
	}
}

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
			const text = textOf(key);
			return text === undefined
				? { view }
				: { view: { ...view, confirm: { ...confirm, typed: typed + text } } };
		}
	}
}

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
			const text = textOf(key);
			return text === undefined ? view : { ...view, search: { query: query + text, typing: true } };
		}
	}
}

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
			services: isApp ? [] : [part.name, ...(part.extraDaemons ?? [])],
			label: part.name,
		};
	}
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
