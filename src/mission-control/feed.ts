import { kindOf, type Service } from "../catalogue.ts";
import { loadProject, type Project } from "../config.ts";
import { BasepadError } from "../internal/exec.ts";
import { daemonId, layout, type Machine, placeOf } from "../layout.ts";
import type { DaemonInfo, LogEntry, Supervisor } from "../supervisor.ts";
import { listWorktrees, mainBranch } from "../worktrees.ts";
import type { EnvironmentView, LogLine, Part, Snapshot } from "./model.ts";

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
 * is known). Resolves once the first read is done. `changed` is called when there is something new.
 */
export async function openFeed(options: {
	main: Project;
	machine: Machine;
	supervisor: Supervisor;
	changed(): void;
}): Promise<Feed> {
	const { main, machine, supervisor, changed } = options;
	const logs = new Map<string, LogLine[]>();
	const arrivals: number[] = [];
	/** Each worktree's config by folder, read once: a config that does not load, as its reason. */
	const configs = new Map<string, Project | string>();
	let environments: EnvironmentView[] = [];
	let seq = 0;
	let dirty = false;
	let following = "";
	let unfollow = () => {};
	let closed = false;

	const take = (entry: LogEntry) => {
		const lines = logs.get(entry.id) ?? [];
		lines.push({ seq: seq++, id: entry.id, time: entry.time, text: entry.text });
		if (lines.length > KEEP * 1.5) lines.splice(0, lines.length - KEEP);
		logs.set(entry.id, lines);
		arrivals.push(Date.now());
		dirty = true;
	};

	/** Follows every part shown, again from its history whenever the set of parts changes. */
	const follow = (ids: string[]) => {
		const key = ids.join(" ");
		if (key === following || closed) return;
		following = key;
		unfollow();
		logs.clear();
		unfollow = supervisor.follow(ids, HISTORY, take);
	};

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
		const [trees, daemons, branch] = await Promise.all([
			listWorktrees(main),
			supervisor.daemons(),
			mainBranch(main),
		]);
		const byId = new Map(daemons.map((daemon) => [daemon.id, daemon]));
		const next = [await environmentOf(main, undefined, branch, main.root, byId, machine)];
		for (const tree of trees.filter((t) => t.present)) {
			const config = await configOf(tree.root);
			next.push(
				typeof config === "string"
					? {
							namespace: `${main.name}.${tree.suffix}`,
							label: tree.suffix,
							...(tree.branch === undefined ? {} : { branch: tree.branch }),
							dir: tree.root,
							apps: [],
							services: [],
							problem: config,
						}
					: await environmentOf(config, tree.suffix, tree.branch, tree.root, byId, machine),
			);
		}
		environments = next;
		dirty = true;
		const ids = new Set(next.flatMap((env) => [...env.apps, ...env.services].map((p) => p.id)));
		follow([...ids].sort());
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
			return { project: main.name, environments, logs, rate: arrivals.length };
		},
		refresh() {
			void tick();
		},
		close() {
			closed = true;
			for (const timer of timers) clearInterval(timer);
			unfollow();
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
	const base = {
		label: suffix ?? "main",
		...(branch === undefined ? {} : { branch }),
		dir,
	};
	let lay: ReturnType<typeof layout>;
	try {
		lay = layout(project, machine, suffix);
	} catch (error) {
		if (!(error instanceof BasepadError)) throw error;
		const namespace = suffix === undefined ? project.name : `${project.name}.${suffix}`;
		return { namespace, ...base, apps: [], services: [], problem: error.message };
	}
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
