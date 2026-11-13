/**
 * What a project's `basepad.config.ts` imports: `defineConfig` and the service kinds. ADR 0001: the
 * config is the only way a project talks to basepad.
 */

/** A process of the project's own that basepad runs and gives a domain. */
export interface App {
	/** The shell command that starts it. It is given a free port as `PORT`. */
	run: string;
	/** The folder it runs in, relative to the config. Defaults to the config's folder. */
	cwd?: string;
}

/** A Postgres server of the project's own, with one database for this service. */
export interface PostgresService {
	kind: "postgres";
	version: PostgresVersion;
}

export type PostgresVersion = 17 | 18;

/** Something basepad provides to an environment from its catalogue. */
export type Service = PostgresService;

/** What a service gives to `env`. The password is a placeholder: local connections are trusted. */
export interface ServiceOutputs {
	url: string;
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

/** What an app gives to `env`. Its port is not given: it changes from run to run. */
export interface AppOutputs {
	/** `https://<app>.<name>.localhost`, with the proxy's port when `basepad setup` was not run. */
	url: string;
}

/** Each env file's path, relative to the config, to the keys basepad sets in it. */
export type EnvFiles = Record<string, Record<string, string | number>>;

export type Outputs<S extends Record<string, Service>, A extends Record<string, App>> = {
	[K in keyof S]: ServiceOutputs;
} & { [K in keyof A]: AppOutputs };

export interface Config<
	S extends Record<string, Service> = Record<string, Service>,
	A extends Record<string, App> = Record<string, App>,
> {
	/**
	 * The project's one key: a lowercase DNS label. Every database and domain is built from it.
	 */
	name: string;
	services?: S;
	/** Each app is served at `https://<key>.<name>.localhost`; keys are lowercase DNS labels. */
	apps?: A;
	/** Which values go into which env files. basepad sets exactly these keys and nothing else. */
	env?: (outputs: Outputs<S, A>) => EnvFiles;
}

/** Types a project's config. It returns the config unchanged. */
export function defineConfig<
	const S extends Record<string, Service> = Record<never, Service>,
	const A extends Record<string, App> = Record<never, App>,
>(config: Config<S, A>): Config<S, A> {
	return config;
}

/** A Postgres server of the project's own. `version` is 17 or 18; it defaults to 18. */
export function postgres(options: { version?: PostgresVersion } = {}): PostgresService {
	return { kind: "postgres", version: options.version ?? 18 };
}

/** What `basepad.config.local.ts` exports: a function from the project's config to a config. */
export type LocalConfig = (config: Config) => Config;
