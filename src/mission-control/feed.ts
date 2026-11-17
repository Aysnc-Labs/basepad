import { homedir } from "node:os";
import { kindOf, type Service } from "../catalogue.ts";
import { loadProject, type Project } from "../config.ts";
import { BasepadError } from "../internal/exec.ts";
import { daemonId, layout, type Machine, namespaceOf, ofDaemon, placeOf } from "../layout.ts";
import type { DaemonInfo, Supervisor } from "../supervisor.ts";
import { hasChanges, listWorktrees, mainBranch } from "../worktrees.ts";
import type { EnvironmentView, LogLine, Part, Snapshot } from "./model.ts";
import { type Running, takeWork } from "./work.ts";

export interface Feed {
	snapshot(): Snapshot;
	refresh(): void;
	notices(): string[];
	close(): void;
}

const REFRESH_MS = 1000;
const CHANGED_MS = 100;
const HISTORY = 200;
const KEEP = 2000;

export async function openFeed(options: {
	main: Project;
	machine(): Machine;
	supervisor: Supervisor;
	work: string;
	changed(): void;
}): Promise<Feed> {
	const { main, machine, supervisor, changed } = options;
	const arrivals: number[] = [];
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
		const work = await takeWork(options.work);
		running = work.running;
		notices.push(...work.finished);
		const [trees, daemons, branch] = await Promise.all([
			listWorktrees(main),
			supervisor.daemons(),
			mainBranch(main),
		]);
		const byId = new Map(daemons.map((daemon) => [daemon.id, daemon]));
		const here = machine();
		const next = [await environmentOf(main, undefined, branch, main.root, byId, here)];
		const adding = running.flatMap((w) => (w.before === undefined ? [] : [w.before]));
		const shown = trees.filter((t) => t.present && adding.every((was) => was.includes(t.suffix)));
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
					: await environmentOf(config, tree.suffix, tree.branch, tree.root, byId, here)),
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
	interface Follower {
		ids: Set<string>;
		stop(): void;
	}
	const owner = new Map<string, Follower>();
	let seq = 0;
	const start = (ids: string[], lines: number) => {
		const follower: Follower = { ids: new Set(ids), stop: () => {} };
		for (const id of ids) owner.set(id, follower);
		follower.stop = follow(ids, lines, (entry) => {
			if (owner.get(entry.id) !== follower) return;
			const kept = logs.get(entry.id) ?? [];
			kept.push({ seq: seq++, id: entry.id, time: entry.time, text: entry.text, at: Date.now() });
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
			for (const follower of shrunk) {
				follower.stop();
				if (follower.ids.size > 0) start([...follower.ids], 0);
			}
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

export async function environmentOf(
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
		dir: shortened(dir),
	};
	const apps = Object.entries(lay.apps).map(([key, app]): Part => {
		const id = daemonId(lay.namespace, key);
		const daemon = daemons.get(id);
		const running = daemon?.state === "running";
		return {
			id,
			name: key,
			state: daemon?.state ?? "stopped",
			...(app.url === undefined ? {} : { address: app.url }),
			...(running && daemon.port !== undefined
				? { note: `:${daemon.port}${daemon.pid === undefined ? "" : `  pid ${daemon.pid}`}` }
				: {}),
			...(daemon?.error === undefined ? {} : { error: daemon.error }),
		};
	});
	const services: Part[] = [];
	const stateOf = (daemon: DaemonInfo | undefined) =>
		daemon === undefined || daemon.state === "idle" ? "stopped" : daemon.state;
	const errorOf = (daemon: DaemonInfo | undefined) =>
		daemon?.error === undefined ? {} : { error: daemon.error };
	for (const [key, service] of Object.entries(project.services) as [string, Service][]) {
		const place = placeOf(project, lay, machine, key);
		const kind = kindOf(service);
		const daemon = daemons.get(place.daemon);
		const extras = Object.entries(place.extraDaemons);
		services.push({
			id: place.daemon,
			name: key,
			state: stateOf(daemon),
			address: await kind.address(service, place),
			note: service.kind,
			...(extras.length === 0
				? {}
				: { extraDaemons: extras.map(([, extra]) => ofDaemon(extra.daemon).name) }),
			...errorOf(daemon),
		});
		for (const [extra, { daemon: id }] of extras) {
			const address = await kind.extraAddress?.(service, place, extra);
			services.push({
				id,
				name: ofDaemon(id).name,
				state: stateOf(daemons.get(id)),
				...(address === undefined ? {} : { address }),
				note: `with ${key}`,
				...errorOf(daemons.get(id)),
			});
		}
	}
	return { namespace: lay.namespace, ...base, apps, services };
}

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
		dir: shortened(dir),
		apps: [],
		services: [],
		problem,
	};
}

function shortened(dir: string): string {
	const home = homedir();
	return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}
