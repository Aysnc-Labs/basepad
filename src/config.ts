import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { FACTORIES, SCHEMAS, type Service } from "./catalogue.ts";
import type { App, Config, EnvFiles, Outputs } from "./index.ts";
import { BasepadError } from "./internal/exec.ts";

export const CONFIG_FILE = "basepad.config.ts";
export const LOCAL_FILE = "basepad.config.local.ts";

/** One plain description of the project, from its config and the local file over it. */
export interface Project {
	/** The config file's real path. */
	file: string;
	/** The config's folder: app folders and env file paths are relative to it. */
	root: string;
	name: string;
	services: Record<string, Service>;
	/** Each app with its folder made absolute. */
	apps: Record<string, Required<Omit<App, "port">> & Pick<App, "port">>;
	env: (outputs: Outputs<Record<string, Service>, Record<string, App>>) => EnvFiles;
	/** How worktrees are named, and where they are checked out when the config says. */
	worktrees: {
		prefix: string;
		/** Absolute. When absent, beside the git repository (the Worktrees module decides). */
		dir?: string;
		/** Paths relative to the config, copied from main's folder into a new worktree's. */
		clone: string[];
		/** Shell commands run in order in a new worktree's folder. */
		setup: string[];
	};
}

/**
 * Finds `basepad.config.ts` in `cwd` or its nearest parent that has one, loads it and the local
 * file beside it, and validates the result. Every failure is a `BasepadError` naming the file,
 * and the key when one is at fault.
 */
export async function loadProject(cwd: string): Promise<Project> {
	const file = findConfig(cwd);
	const root = dirname(file);
	let config = validate(await importDefault(file), file);
	const local = join(root, LOCAL_FILE);
	if (existsSync(local)) {
		const override = await importDefault(local);
		if (typeof override !== "function") {
			throw new BasepadError(
				`${local}: its default export must be a function from the project's config to a config.`,
			);
		}
		let changed: unknown;
		try {
			changed = await override(config);
		} catch (error) {
			throw new BasepadError(`${local} threw: ${messageOf(error)}`);
		}
		config = validate(changed, local);
	}
	return {
		file,
		root,
		name: config.name,
		services: config.services ?? {},
		apps: Object.fromEntries(
			Object.entries(config.apps ?? {}).map(([key, app]) => [
				key,
				{
					run: app.run,
					cwd: resolve(root, app.cwd ?? "."),
					...(app.port === false ? { port: false as const } : {}),
				},
			]),
		),
		env: (config.env as Project["env"] | undefined) ?? (() => ({})),
		worktrees: {
			prefix: config.worktrees?.prefix ?? "worktree",
			clone: config.worktrees?.clone ?? [],
			setup: config.worktrees?.setup ?? [],
			...(config.worktrees?.dir === undefined ? {} : { dir: resolve(root, config.worktrees.dir) }),
		},
	};
}

function findConfig(cwd: string): string {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const file = join(dir, CONFIG_FILE);
		if (existsSync(file)) return realpathSync(file);
		if (dirname(dir) === dir) break;
	}
	throw new BasepadError(
		`No ${CONFIG_FILE} in ${cwd} or any folder above it. Run \`basepad init\` to write one.`,
	);
}

/** What a config imports basepad as. */
const PACKAGE = "@aysnc-labs/basepad";
/** The running basepad's own entry: `index.ts` from source, `index.js` once built. */
const OWN_INDEX = new URL(
	import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js",
	import.meta.url,
).href;

/** Real paths of the files basepad loads; the hook reads each as TypeScript ESM. */
const typescriptFiles = new Set<string>();
let hooked = false;

/**
 * Imports a file as TypeScript ESM, whatever the nearest `package.json` says about module type, so
 * a project never renames files or changes settings for basepad, and Node prints no warning.
 */
async function importDefault(file: string): Promise<unknown> {
	const real = realpathSync(file);
	typescriptFiles.add(pathToFileURL(real).href);
	if (!hooked) {
		hooked = true;
		registerHooks({
			resolve(specifier, context, nextResolve) {
				try {
					return nextResolve(specifier, context);
				} catch (error) {
					// A fresh worktree has no `node_modules` yet: its config gets the running basepad.
					const fromConfig = context.parentURL && typescriptFiles.has(context.parentURL);
					if (specifier !== PACKAGE || !fromConfig) throw error;
					return { url: OWN_INDEX, shortCircuit: true };
				}
			},
			load(url, context, nextLoad) {
				if (!typescriptFiles.has(url)) return nextLoad(url, context);
				const loaded = nextLoad(url, { ...context, format: "module-typescript" });
				return { ...loaded, format: "module-typescript" };
			},
		});
	}
	let module: { default?: unknown };
	try {
		module = await import(pathToFileURL(real).href);
	} catch (error) {
		throw new BasepadError(`${file} failed to load: ${messageOf(error)}`);
	}
	if (module.default === undefined) {
		throw new BasepadError(`${file}: it must \`export default defineConfig({ ... })\`.`);
	}
	return module.default;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A lowercase DNS label: letters, digits and inner hyphens. */
export const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const label = z
	.string({ error: "must be a string" })
	.regex(LABEL, "must be a lowercase DNS label (letters, digits and inner hyphens)");

const AppSchema = z.strictObject({
	run: z.string({ error: "`run` must be a command" }).min(1, "`run` must be a command"),
	cwd: z.string({ error: "`cwd` must be a folder relative to the config" }).optional(),
	port: z
		.literal(false, { error: "`port` can only be `false`, for an app that listens on nothing" })
		.optional(),
});

const ConfigSchema = z
	.strictObject({
		name: label,
		services: z
			.record(
				label,
				// Each kind's schema is a strict object with a literal `kind`, as a discriminated union needs.
				z.discriminatedUnion("kind", SCHEMAS as unknown as [z.ZodObject], {
					error: `a service must be made by a service function, such as ${FACTORIES.join(" or ")}`,
				}),
			)
			.optional(),
		apps: z.record(label, AppSchema).optional(),
		env: z
			.custom<Config["env"]>((value) => typeof value === "function", {
				error: "`env` must be a function from outputs to env files",
			})
			.optional(),
		worktrees: z
			.strictObject({
				prefix: label.optional(),
				dir: z
					.string({ error: "must be a folder relative to the config" })
					.min(1, "must be a folder relative to the config")
					.optional(),
				clone: z
					.array(
						z
							.string({ error: "each must be a path relative to the config" })
							.min(1, "each must be a path relative to the config")
							.refine(
								(path) => !isAbsolute(path) && !normalize(path).startsWith(".."),
								"each must be a path inside the config's folder",
							),
					)
					.optional(),
				setup: z
					.array(
						z
							.string({ error: "each must be a shell command" })
							.min(1, "each must be a shell command"),
					)
					.optional(),
			})
			.optional(),
	})
	.superRefine((config, ctx) => {
		// Services and apps share one namespace: `env`'s outputs and the supervisor's daemons.
		for (const key of Object.keys(config.services ?? {})) {
			if (config.apps && key in config.apps) {
				ctx.addIssue({
					code: "custom",
					path: ["apps", key],
					message: "a service has the same key; a key names one service or one app",
				});
			}
		}
	});

function validate(value: unknown, file: string): Config {
	const result = ConfigSchema.safeParse(value);
	if (result.success) return result.data as Config;
	const lines = result.error.issues.map((issue) => {
		const at = issue.path.map(String).join(".");
		if (issue.code === "unrecognized_keys") {
			const keys = issue.keys.map((key) => `\`${at ? `${at}.` : ""}${key}\``).join(", ");
			return `unknown key ${keys}`;
		}
		// A bad record key's own reason is nested inside the issue.
		const message =
			issue.code === "invalid_key" ? (issue.issues[0]?.message ?? issue.message) : issue.message;
		return at ? `\`${at}\`: ${message}` : message;
	});
	throw new BasepadError(`${file} is invalid:\n  ${lines.join("\n  ")}`);
}
