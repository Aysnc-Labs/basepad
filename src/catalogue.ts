import type { z } from "zod";
import { mailpitKind } from "./catalogue/mailpit.ts";
import { postgresKind } from "./catalogue/postgres.ts";
import { redisKind } from "./catalogue/redis.ts";
import type { Machine } from "./layout.ts";
import type { Daemon } from "./supervisor.ts";

/**
 * The catalogue: what basepad provides to an environment, one module per service kind behind one
 * interface. A kind owns its config schema, its outputs and the names it derives; a new kind is a
 * new module, an entry in `CATALOGUE` and its factory exported from `index.ts`, and neither
 * commands, Config nor Layout change.
 */

/** What every kind's config entry has: the kind's name, as its factory sets it. */
export interface ServiceBase {
	kind: string;
}

/** What a kind's `names` is given for one service. */
export interface NameInput {
	/** The project's name. */
	name: string;
	/** The service's key in the config. */
	key: string;
	/** The service's own folder in basepad's home, from Layout. */
	dir: string;
	/** A worktree's suffix; absent in main. */
	suffix?: string;
}

/** Where one service of an environment lives: Layout's place for it, with its kind's names. */
export type Place<N = unknown> = {
	/** The project's name. */
	name: string;
	/** The service's key in the config. */
	key: string;
	/** The checkout that owns the environment: the config's folder. */
	owner: string;
	/** A worktree's suffix; absent in main. */
	suffix?: string;
	/** The service's own folder in basepad's home: its data, nothing that records a decision. */
	dir: string;
	/** The port first tried; a taken one is passed over. */
	port: number;
	/** Its domain, from Layout, when its kind asks for one (`Kind.web`). */
	web?: Web;
	machine: Machine;
} & N;

/**
 * A service's domain: its web page, served by the supervisor's proxy over HTTPS at
 * `<key>.<name>.localhost`, one for main and every worktree, as the service is main's.
 */
export interface Web {
	host: string;
	/** What `env` and `status` show. */
	url: string;
	/** The port its daemon is first offered as `PORT`, which it serves its page on. */
	port: number;
}

/** One piece of data a service keeps for a worktree. */
export interface WorktreeData {
	/** Its name, unique among the service's worktree data. */
	name: string;
	/** The folder stamped on it as its owner; empty when unstamped. */
	owner: string;
}

/** One service kind: `S` its config entry, `O` what it gives to `env`, `N` the names it derives. */
export interface Kind<S extends ServiceBase, O, N> {
	/** Validates one config entry of this kind: a strict object whose `kind` is a literal. */
	schema: z.ZodType<S>;
	/**
	 * Asks for a domain: Layout puts `web` in the service's place, and the daemon `prepare` returns
	 * must take `web.port` as its `port`, so the proxy serves it there.
	 */
	web?: true;
	/**
	 * Whether a worktree runs a server of its own for this service; absent or false, it uses main's,
	 * one server for all of a project's environments. Pure, so Layout calls it.
	 */
	perEnvironment?(service: S): boolean;
	/**
	 * The names this kind derives for one service, in main or in a worktree. Pure, so Layout calls
	 * it. Throws a `BasepadError` with the reason when a name is past the kind's limit; never
	 * truncates.
	 */
	names(service: S, input: NameInput): N;
	/**
	 * Installs what the service needs, prepares its data once and returns the daemon the
	 * supervisor runs. Safe while the service runs: it keeps the port it has.
	 */
	prepare(service: S, place: Place<N>): Promise<Daemon>;
	/**
	 * Waits until the running service answers, provisions it for this environment and returns what
	 * it gives to `env`. In a worktree it provisions from main's, as the service's `worktree` option
	 * says, so main's must be provisioned first. Throws a `BasepadError` when another checkout owns
	 * what it provisions, unless `claim`, and `Stopped` (`internal/ports.ts`) as soon as `stopped`
	 * says its daemon is no longer running. `print` tells the developer what it did that they would
	 * want to know. Not `started` (a worktree's own server, until the worktree starts): waits for
	 * nothing and returns what it will give once its prepared daemon runs.
	 */
	provision(
		service: S,
		place: Place<N>,
		options: {
			claim: boolean;
			started: boolean;
			stopped: () => Promise<boolean>;
			print(line: string): void;
		},
	): Promise<O>;
	/** The data this service keeps for worktrees; absent for a kind that keeps none. */
	worktreeData?: WorktreeDataStore<S, N>;
	/** Where a client reaches the service: where it runs, else where it would first be tried. */
	address(service: S, place: Place<N>): Promise<string>;
	/** The `db` commands, for a kind that is a database; absent for one that is not. */
	database?: Database<S, N>;
}

/** What a kind that keeps data for worktrees does with it, for `worktree rm` and `prune`. */
export interface WorktreeDataStore<S, N> {
	/**
	 * The data kept for worktrees, never main's own. In main's place, every worktree's; in a
	 * worktree's, that worktree's: stamped with its folder (`owner`), or unstamped under its name.
	 * Needs no worktree config. Data only a running server can list is not found while it is stopped.
	 */
	list(service: S, place: Place<N>): Promise<WorktreeData[]>;
	/** Deletes worktree data by name. Throws on main's own, and deletes nothing. */
	drop(service: S, place: Place<N>, names: string[]): Promise<void>;
}

/** One snapshot of an environment's database, found on the server by its name. */
export interface Snapshot {
	label: string;
	/** The environment's database it was saved from. */
	database: string;
	bytes: number;
}

/**
 * What a database kind does for the `db` commands. Each acts on the environment's own database in
 * `place`, on the running server, and never on another environment's: a worktree's commands leave
 * main's untouched. Each throws a `BasepadError` when the environment's database is not its own
 * (a worktree's `shared` service). Clients connected to a database a command replaces are
 * disconnected and connect again by themselves.
 */
export interface Database<S, N> {
	/**
	 * Saves the database as snapshot `label`, replacing one of that label only once the new one is
	 * whole, so a save that fails keeps it. Throws a `BasepadError` when the label makes a name past
	 * the kind's limit.
	 */
	save(service: S, place: Place<N>, label: string): Promise<void>;
	/**
	 * Replaces the database with snapshot `label`, which stays, only once the copy is whole, so a
	 * load that fails leaves the database as it was. Throws when there is none.
	 */
	load(service: S, place: Place<N>, label: string): Promise<void>;
	/** The environment's snapshots, by label. */
	snapshots(service: S, place: Place<N>): Promise<Snapshot[]>;
	/** Deletes snapshot `label`. Throws when there is none. */
	remove(service: S, place: Place<N>, label: string): Promise<void>;
	/**
	 * Replaces the database with `source`: a dump file, its format told from its first bytes, or a
	 * URL of another server's database, which is copied. Checks the file, then awaits
	 * `confirm(database)` with the database's name before it changes anything; `confirm` throws to
	 * stop. The source loads into a database beside it, which takes its place only once all of it
	 * has loaded, so a source that fails leaves the database as it was. Resolves to what the source
	 * was read as, for the user.
	 */
	import(
		service: S,
		place: Place<N>,
		source: string,
		confirm: (database: string) => Promise<void>,
	): Promise<string>;
	/**
	 * Writes a dump of the database that `import` reads, to `file`, else to standard output, in a
	 * format the kind picks from the file's name; its clients stay connected. Resolves to the format
	 * written, for the user.
	 */
	export(service: S, place: Place<N>, file: string | undefined): Promise<string>;
}

/** Every kind, by the name its factory has in a config. */
const CATALOGUE = { postgres: postgresKind, redis: redisKind, mailpit: mailpitKind };
type Catalogue = typeof CATALOGUE;

/** Something basepad provides to an environment: one config entry of a kind in the catalogue. */
export type Service = {
	[K in keyof Catalogue]: Catalogue[K] extends { schema: z.ZodType<infer S> } ? S : never;
}[keyof Catalogue];

/** What a service of kind `S` gives to `env`. */
export type OutputsOf<S extends Service> = Catalogue[S["kind"]] extends {
	provision(...args: never[]): Promise<infer O>;
}
	? O
	: never;

/** The names a service of kind `S` derives. */
export type NamesOf<S extends Service> = ReturnType<Catalogue[S["kind"]]["names"]>;

/** The kind that provides `service`. */
export function kindOf<S extends Service>(service: S): Kind<S, OutputsOf<S>, NamesOf<S>> {
	return CATALOGUE[service.kind] as unknown as Kind<S, OutputsOf<S>, NamesOf<S>>;
}

/** Every kind's schema, for Config. */
export const SCHEMAS: z.ZodType<Service>[] = Object.values(CATALOGUE).map((kind) => kind.schema);

/** Every kind's factory as a config calls it, for messages: `postgres()`. */
export const FACTORIES: string[] = Object.keys(CATALOGUE).map((kind) => `\`${kind}()\``);
