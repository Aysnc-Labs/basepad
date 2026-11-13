import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { App, Config, EnvFiles, Outputs, Service } from "./index.ts";
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
	apps: Record<string, Required<App>>;
	env: (outputs: Outputs<Record<string, Service>, Record<string, App>>) => EnvFiles;
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
				{ run: app.run, cwd: resolve(root, app.cwd ?? ".") },
			]),
		),
		env: (config.env as Project["env"] | undefined) ?? (() => ({})),
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
			load(url, context, nextLoad) {
				const bare = url.split("?")[0] as string;
				if (!typescriptFiles.has(bare)) return nextLoad(url, context);
				const loaded = nextLoad(url, { ...context, format: "module-typescript" });
				return { ...loaded, format: "module-typescript" };
			},
		});
	}
	let module: { default?: unknown };
	try {
		// A fresh URL each time, so a changed file is read again within one process.
		module = await import(`${pathToFileURL(real).href}?t=${Date.now()}-${Math.random()}`);
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
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const label = (what: string) =>
	z
		.string({ error: `${what} must be a string` })
		.regex(LABEL, `${what} must be a lowercase DNS label (letters, digits and inner hyphens)`);

const Postgres = z.strictObject({
	kind: z.literal("postgres"),
	version: z.union([z.literal(17), z.literal(18)], { error: "Postgres version must be 17 or 18" }),
});

const AppSchema = z.strictObject({
	run: z.string({ error: "`run` must be a command" }).min(1, "`run` must be a command"),
	cwd: z.string({ error: "`cwd` must be a folder relative to the config" }).optional(),
});

const ConfigSchema = z.strictObject({
	name: label("`name`"),
	services: z
		.record(
			label("A service key"),
			z.discriminatedUnion("kind", [Postgres], {
				error: "a service must be made by a service function, such as `postgres()`",
			}),
		)
		.optional(),
	apps: z.record(label("An app key"), AppSchema).optional(),
	env: z
		.custom<Config["env"]>((value) => typeof value === "function", {
			error: "`env` must be a function from outputs to env files",
		})
		.optional(),
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
		return at ? `\`${at}\`: ${issue.message}` : issue.message;
	});
	throw new BasepadError(`${file} is invalid:\n  ${lines.join("\n  ")}`);
}
