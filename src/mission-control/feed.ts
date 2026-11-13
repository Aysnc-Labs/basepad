import { kindOf, type Service } from "../catalogue.ts";
import { loadProject, type Project } from "../config.ts";
import { BasepadError } from "../internal/exec.ts";
import { daemonId, layout, type Machine, namespaceOf, ofDaemon, placeOf } from "../layout.ts";
import type { DaemonInfo, Supervisor } from "../supervisor.ts";
import { hasChanges, listWorktrees, mainBranch } from "../worktrees.ts";
import type { EnvironmentView, LogLine, Part, Snapshot } from "./model.ts";
import { type Running, takeWork } from "./work.ts";

/**
 * Mission control's feed: the one adapter between the view and what runs. It reads environments
 * from git and their configs, states from the supervisor, and follows every part's output live.
 * It only reads: closing it, or a crash in it, stops nothing.
 */
export interface Feed {
	/** The latest of everything; cheap, called on every repaint. */
	snapshot(): Snapshot;
	/** Reads states again now, as after an action, rather than on the next tick. */
	refresh(): void;
	/** What finished work (a worktree added or removed) has to say since last asked, oldest first. */
	notices(): string[];
	close(): void;
}

/** How often states and worktrees are read again. */
const REFRESH_MS = 1000;
/** How often a change is passed on at most: a burst of output becomes one repaint. */
const CHANGED_MS = 100;
/** Lines of each part's output from before the view opened. */
const HISTORY = 200;
/** Lines kept per part, the scrollback; older ones are dropped. */
const KEEP = 2000;

/**
 * Opens the feed on `main`'s project and its worktrees, as served on `machine` (whose `portFree`
 * is known), with the worktree work in `work` (`startWork`'s folder). Resolves once the first read
 * is done. `changed` is called when there is something new.
 */
export async function openFeed(options: {
	main: Project;
	machine: Machine;
	supervisor: Supervisor;
	work: string;
	changed(): void;
}): Promise<Feed> {
	const { main, machine, supervisor, changed } = options;
	const arrivals: number[] = [];
	/** Each worktree's config by folder, read once: a config that does not load, as its reason. */
	const configs = new Map<string, Project | string>();
	let environments: EnvironmentView[] = [];
	let dirty = false;
	let closed = false;
	const book = logBook(supervisor.follow, HISTORY, () => {
		arrivals.push(Date.now());
		dirty = true;
	});
	let running: Running[] = [];
	const notices: string[] = [];

	const configOf = async (root: string): Promise<Project | string> => {
		let config = configs.get(root);
		if (config === undefined) {
			config = await loadProject(root).catch((error: unknown) =>
				error instanceof BasepadError ? error.message : String(error),
			);
			configs.set(root, config);
		}
		return config;
	};

	const refresh = async () => {
		// First and alone: what finished is told once, whatever fails after.
		const work = await takeWork(options.work);
		running = work.running;
		notices.push(...work.finished);
		const [trees, daemons, branch] = await Promise.all([
			listWorktrees(main),
			supervisor.daemons(),
			mainBranch(main),
		]);
		const byId = new Map(daemons.map((daemon) => [daemon.id, daemon]));
		const next = [await environmentOf(main, undefined, branch, main.root, byId, machine)];
		// A worktree being added shows once it is ready: until then, only those there before it began.
		const adding = running.flatMap((w) => (w.before === undefined ? [] : [w.before]));
		const shown = trees.filter((t) => t.present && adding.every((was) => was.includes(t.suffix)));
		// A worktree removed and made again under its suffix reads its config again.
		for (const root of configs.keys()) {
			if (!shown.some((t) => t.root === root)) configs.delete(root);
		}
		const changes = await Promise.all(shown.map((t) => hasChanges(t.path).catch(() => undefined)));
		for (const [i, tree] of shown.entries()) {
			const changed = changes[i] === undefined ? {} : { changes: changes[i] };
			const config = await configOf(tree.root);
			next.push({
				...(typeof config === "string"
					? troubled(main.name, tree.suffix, tree.branch, tree.root, config)
					: await environmentOf(config, tree.suffix, tree.branch, tree.root, byId, machine)),
				...changed,
			});
		}
		environments = next;
		dirty = true;
		const ids = new Set(next.flatMap((env) => [...env.apps, ...env.services].map((p) => p.id)));
		if (!closed) book.follow([...ids].sort());
	};

	let reading = false;
	const tick = async () => {
		if (reading || closed) return;
		reading = true;
		// A failed read keeps the last snapshot; the next tick tries again.
		await refresh().catch(() => {});
		reading = false;
	};
	await refresh();
	const timers = [
		setInterval(tick, REFRESH_MS),
		setInterval(() => {
			if (!dirty || closed) return;
			dirty = false;
			changed();
		}, CHANGED_MS),
	];

	return {
		snapshot() {
			const since = Date.now() - 1000;
			while (arrivals.length > 0 && (arrivals[0] as number) < since) arrivals.shift();
			return {
				project: main.name,
				environments,
				logs: book.logs,
				rate: arrivals.length,
				work: running,
			};
		},
		refresh() {
			void tick();
		},
		notices() {
			return notices.splice(0);
		},
		close() {
			closed = true;
			for (const timer of timers) clearInterval(timer);
			book.close();
		},
	};
}

/**
 * Every shown part's output, followed live: the scrollback, by daemon id. `follow` sets the parts
 * shown. A part shown for the first time is followed from its last `history` lines; a part already
 * followed keeps its lines and their arrival numbers, so a paused stream stays where it is. A part
 * no longer shown loses its lines and is tailed no more. Each environment's parts are followed
 * together. `read` is told of each line.
 */
export function logBook(
	follow: Supervisor["follow"],
	history: number,
	read: () => void,
): {
	logs: ReadonlyMap<string, readonly LogLine[]>;
	follow(ids: readonly string[]): void;
	close(): void;
} {
	const logs = new Map<string, LogLine[]>();
	/** One supervisor follower: the ids it was started for that are still its own. */
	interface Follower {
		ids: Set<string>;
		stop(): void;
	}
	/** Which follower each shown id's lines are taken from. */
	const owner = new Map<string, Follower>();
	let seq = 0;
	/** Starts following `ids`, from their last `lines` lines: their lines are taken from it. */
	const start = (ids: string[], lines: number) => {
		const follower: Follower = { ids: new Set(ids), stop: () => {} };
		for (const id of ids) owner.set(id, follower);
		follower.stop = follow(ids, lines, (entry) => {
			// A part shown again has a follower of its own; an old one's copy is not taken.
			if (owner.get(entry.id) !== follower) return;
			const kept = logs.get(entry.id) ?? [];
			kept.push({ seq: seq++, id: entry.id, time: entry.time, text: entry.text });
			if (kept.length > KEEP * 1.5) kept.splice(0, kept.length - KEEP);
			logs.set(entry.id, kept);
			read();
		});
	};
	return {
		logs,
		follow(ids) {
			const shown = new Set(ids);
			const shrunk = new Set<Follower>();
			for (const [id, follower] of owner) {
				if (shown.has(id)) continue;
				owner.delete(id);
				logs.delete(id);
				follower.ids.delete(id);
				shrunk.add(follower);
			}
			// A follower tails exactly what is shown: one that lost a part starts again on the rest,
			// whose lines it already has.
			for (const follower of shrunk) {
				follower.stop();
				if (follower.ids.size > 0) start([...follower.ids], 0);
			}
			// Each environment's new parts on a follower of their own, so a worktree removed stops
			// exactly its own.
			const added = Map.groupBy(
				ids.filter((id) => !owner.has(id)),
				(id) => ofDaemon(id).namespace,
			);
			for (const group of added.values()) start(group, history);
		},
		close() {
			for (const follower of new Set(owner.values())) follower.stop();
			owner.clear();
		},
	};
}

/** One environment's parts, with states from the supervisor and addresses from Layout. */
async function environmentOf(
	project: Project,
	suffix: string | undefined,
	branch: string | undefined,
	dir: string,
	daemons: Map<string, DaemonInfo>,
	machine: Machine,
): Promise<EnvironmentView> {
	let lay: ReturnType<typeof layout>;
	try {
		lay = layout(project, machine, suffix);
	} catch (error) {
		if (!(error instanceof BasepadError)) throw error;
		return troubled(project.name, suffix, branch, dir, error.message);
	}
	const base = {
		label: suffix ?? "main",
		...(branch === undefined ? {} : { branch }),
		dir,
	};
	const apps = Object.entries(lay.apps).map(([key, app]): Part => {
		const id = daemonId(lay.namespace, key);
		const daemon = daemons.get(id);
		const running = daemon?.state === "running";
		return {
			id,
			name: key,
			state: daemon?.state ?? "stopped",
			address: app.url,
			...(running && daemon.port !== undefined
				? { note: `:${daemon.port}${daemon.pid === undefined ? "" : `  pid ${daemon.pid}`}` }
				: {}),
			...(daemon?.error === undefined ? {} : { error: daemon.error }),
		};
	});
	const services: Part[] = [];
	for (const [key, service] of Object.entries(project.services) as [string, Service][]) {
		const id = daemonId(lay.mainNamespace, key);
		const daemon = daemons.get(id);
		services.push({
			id,
			name: key,
			// A service is not started by a request of its own, so not running is stopped.
			state: daemon === undefined || daemon.state === "idle" ? "stopped" : daemon.state,
			address: await kindOf(service).address(service, placeOf(project, lay, machine, key)),
			note: service.kind,
			...(daemon?.error === undefined ? {} : { error: daemon.error }),
		});
	}
	return { namespace: lay.namespace, ...base, apps, services };
}

/** An environment whose parts cannot be shown, with why: a config that does not load, or names past their limits. */
function troubled(
	name: string,
	suffix: string | undefined,
	branch: string | undefined,
	dir: string,
	problem: string,
): EnvironmentView {
	return {
		namespace: namespaceOf(name, suffix),
		label: suffix ?? "main",
		...(branch === undefined ? {} : { branch }),
		dir,
		apps: [],
		services: [],
		problem,
	};
}
