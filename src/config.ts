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

export type ProjectApp = Required<Pick<App, "run" | "cwd">> & Pick<App, "port" | "domain">;

export interface Project {
	file: string;
	root: string;
	name: string;
	services: Record<string, Service>;
	apps: Record<string, ProjectApp>;
	env: (outputs: Outputs<Record<string, Service>, Record<string, App>>) => EnvFiles;
	worktrees: {
		prefix: string;
		dir?: string;
		clone: string[];
		setup: string[];
	};
}

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
					...(app.domain === false ? { domain: false as const } : {}),
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

const PACKAGE = "basepad";
const OWN_INDEX = new URL(
	import.meta.url.endsWith(".ts") ? "./index.ts" : "./index.js",
	import.meta.url,
).href;

const typescriptFiles = new Set<string>();
let hooked = false;

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
	domain: z
		.literal(false, {
			error: "`domain` can only be `false`, for an app served at `https://localhost:$PORT`",
		})
		.optional(),
});

const ConfigSchema = z
	.strictObject({
		name: label,
		services: z
			.record(
				label,
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
		for (const [key, app] of Object.entries(config.apps ?? {})) {
			if (app.port === false && app.domain === false) {
				ctx.addIssue({
					code: "custom",
					path: ["apps", key, "domain"],
					message: "an app with no port has no domain already; drop `domain`",
				});
			}
		}
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
		const message =
			issue.code === "invalid_key" ? (issue.issues[0]?.message ?? issue.message) : issue.message;
		return at ? `\`${at}\`: ${message}` : message;
	});
	throw new BasepadError(`${file} is invalid:\n  ${lines.join("\n  ")}`);
}
