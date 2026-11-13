/**
 * What a project's `basepad.config.ts` imports: `defineConfig` and the service kinds. ADR 0001: the
 * config is the only way a project talks to basepad.
 */

import type { OutputsOf, Service } from "./catalogue.ts";

// Each service kind's factory and types, from its module in the catalogue.
export type {
	PostgresOutputs,
	PostgresService,
	PostgresVersion,
	PostgresWorktree,
} from "./catalogue/postgres.ts";
export { postgres } from "./catalogue/postgres.ts";
export type { Service };

/** A process of the project's own that basepad runs and gives a domain. */
export interface App {
	/** The shell command that starts it. It is given a free port as `PORT`. */
	run: string;
	/** The folder it runs in, relative to the config. Defaults to the config's folder. */
	cwd?: string;
	/**
	 * `false` for an app that listens on nothing, such as a queue worker: no `PORT`, no domain and
	 * no `url` in `env`. It is ready once it runs, and starts with the environment's other apps.
	 */
	port?: false;
	/**
	 * `false` for an app that another app's page loads from, such as Vite: no domain and no `url`
	 * in `env`. It serves HTTPS itself at `https://localhost:$PORT`, with the certificate basepad
	 * gives it as `BASEPAD_TLS_CERT` and `BASEPAD_TLS_KEY`, so the page's browser keeps it local.
	 */
	domain?: false;
}

/** What an app gives to `env`. Its port is not given: it changes from run to run. */
export interface AppOutputs {
	/** `https://<app>.<name>.localhost`, with the proxy's port when `basepad setup` was not run. */
	url: string;
}

/** Each env file's path, relative to the config, to the keys basepad sets in it. */
export type EnvFiles = Record<string, Record<string, string | number>>;

export type Outputs<S extends Record<string, Service>, A extends Record<string, App>> = {
	[K in keyof S]: OutputsOf<S[K]>;
} & {
	[K in keyof A as A[K] extends { port: false } | { domain: false } ? never : K]: AppOutputs;
};

export interface Config<
	S extends Record<string, Service> = Record<string, Service>,
	A extends Record<string, App> = Record<string, App>,
> {
	/**
	 * The project's one key: a lowercase DNS label. Every database and domain is built from it.
	 */
	name: string;
	services?: S;
	/**
	 * Each app is served at `https://<key>.<name>.localhost`, unless its `port` or `domain` is
	 * `false`; keys are lowercase DNS labels.
	 */
	apps?: A;
	/**
	 * Which values go into which env files. basepad sets exactly these keys and nothing else. A
	 * worktree's files start as copies of main's.
	 */
	env?: (outputs: Outputs<S, A>) => EnvFiles;
	/** Worktrees: environments `basepad worktree add` makes from main, each in its own git worktree. */
	worktrees?: {
		/** Worktrees are named `<prefix>-<n>`, with the lowest free `n`. Defaults to `worktree`. */
		prefix?: string;
		/** Where worktrees are checked out, relative to the config. Defaults to `<repository>/../<name>.worktrees`. */
		dir?: string;
		/** Untracked paths, relative to the config, copied from main into each new worktree (copy-on-write where the filesystem can). */
		clone?: string[];
		/** Shell commands run in order in each new worktree, after its env files are written. */
		setup?: string[];
	};
}

/** Types a project's config. It returns the config unchanged. */
export function defineConfig<
	const S extends Record<string, Service> = Record<never, Service>,
	const A extends Record<string, App> = Record<never, App>,
>(config: Config<S, A>): Config<S, A> {
	return config;
}

/** What `basepad.config.local.ts` exports: a function from the project's config to a config. */
export type LocalConfig = (config: Config) => Config;
