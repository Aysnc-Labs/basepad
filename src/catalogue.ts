import type { z } from "zod";
import { postgresKind } from "./catalogue/postgres.ts";
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
}

/** Where one service of an environment lives: Layout's place for it, with its kind's names. */
export type Place<N = unknown> = {
	/** The project's name. */
	name: string;
	/** The service's key in the config. */
	key: string;
	/** The checkout that owns the environment: the config's folder. */
	owner: string;
	/** The service's own folder in basepad's home: its data, nothing that records a decision. */
	dir: string;
	/** The port first tried; a taken one is passed over. */
	port: number;
	machine: Machine;
} & N;

/** One service kind: `S` its config entry, `O` what it gives to `env`, `N` the names it derives. */
export interface Kind<S extends ServiceBase, O, N> {
	/** Validates one config entry of this kind: a strict object whose `kind` is a literal. */
	schema: z.ZodType<S>;
	/**
	 * The names this kind derives for one service. Pure, so Layout calls it. Throws a
	 * `BasepadError` with the reason when a name is past the kind's limit; never truncates.
	 */
	names(input: NameInput): N;
	/**
	 * Installs what the service needs, prepares its data once and returns the daemon the
	 * supervisor runs. Safe while the service runs: it keeps the port it has.
	 */
	prepare(service: S, place: Place<N>): Promise<Daemon>;
	/**
	 * Waits until the running service answers, provisions it for this environment and returns what
	 * it gives to `env`. Throws a `BasepadError` when another checkout owns it, unless `claim`, and
	 * `Stopped` (`internal/ports.ts`) as soon as `stopped` says its daemon is no longer running.
	 */
	provision(
		service: S,
		place: Place<N>,
		options: { claim: boolean; stopped: () => Promise<boolean> },
	): Promise<O>;
	/** Where a client reaches the service: where it runs, else where it would first be tried. */
	address(service: S, place: Place<N>): Promise<string>;
}

/** Every kind, by the name its factory has in a config. */
const CATALOGUE = { postgres: postgresKind };
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
