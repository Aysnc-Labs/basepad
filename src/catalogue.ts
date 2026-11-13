import { postgres } from "./catalogue/postgres.ts";
import type { Service, ServiceOutputs } from "./index.ts";
import type { Machine } from "./layout.ts";
import type { Daemon } from "./supervisor.ts";

/**
 * The catalogue: what basepad provides to an environment, one module per service kind behind one
 * interface. A new kind is a new module and an entry in `CATALOGUE`; commands do not change.
 */

/** Where one service of an environment lives, from Layout. */
export interface Place {
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
	/** The name of what the service provisions for the environment (a database). */
	database: string;
	machine: Machine;
}

export interface Kind<S extends Service = Service> {
	/**
	 * Installs what the service needs, prepares its data once and returns the daemon the
	 * supervisor runs. Safe while the service runs: it keeps the port it has.
	 */
	prepare(service: S, place: Place): Promise<Daemon>;
	/**
	 * Waits until the running service answers, provisions it for this environment and returns what
	 * it gives to `env`. Throws a `BasepadError` when another checkout owns it, unless `claim`.
	 */
	provision(service: S, place: Place, options: { claim: boolean }): Promise<ServiceOutputs>;
	/** Where a client reaches the service: where it runs, else where it would first be tried. */
	address(service: S, place: Place): Promise<string>;
}

const CATALOGUE: { [K in Service["kind"]]: Kind<Extract<Service, { kind: K }>> } = { postgres };

/** The kind that provides `service`. */
export function kindOf<S extends Service>(service: S): Kind<S> {
	return CATALOGUE[service.kind] as Kind<S>;
}
