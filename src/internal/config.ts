import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { BasepadError } from "./exec.ts";
import { NEON_PROXY_DAEMON } from "./neon.ts";
import { PRESETS, type Preset } from "./presets.ts";

/**
 * What a worktree gets of a service: a `copy` of main's data, an `empty` one of its own, or main's
 * own, `shared`.
 */
export const COPIES = ["copy", "empty", "shared"] as const;
export type Copy = (typeof COPIES)[number];

/** The services basepad can add, and the copy strategies each supports, its default first. */
export const CATALOGUE = {
	postgres: { copies: ["copy", "empty", "shared"] },
	/** The shared Postgres, reached through the shared Neon proxy, for Neon's serverless driver. */
	"postgres-neon": { copies: ["copy", "empty", "shared"] },
	mailpit: { copies: ["shared"] },
	redis: { copies: ["empty", "shared"] },
} as const satisfies Record<string, { copies: readonly Copy[] }>;
export type ServiceType = keyof typeof CATALOGUE;
export const SERVICE_TYPES = Object.keys(CATALOGUE) as ServiceType[];

/** A project's service, as its config declares it, with every default filled in. */
export interface ServiceConfig {
	name: string;
	type: ServiceType;
	/** A Postgres service's databases. Unset, the service has one, named after the service. */
	databases?: string[];
	copy: Copy;
}

export interface ProjectConfig {
	preset: Preset;
	/** The app's dev server, which basepad runs as a daemon on the app's port, under its name. */
	app?: { run: string };
	services: ServiceConfig[];
	/** Variable renames: the name basepad would write, to the name the project wants. */
	rename: Record<string, string>;
}

export const CONFIG_FILE = "basepad.toml";

/**
 * The app's daemon in a project's conf.d. Prefixed, because mise exports `<DAEMON>_URL` and
 * `<DAEMON>_PORT` to the project's shell, and a bare `app` would set `APP_URL` over the app's own.
 */
export const APP_DAEMON = "basepad-app";

/** The project's reference to the shared Neon proxy, and its app, take these names, so no service can. */
const RESERVED: Record<string, string> = {
	[NEON_PROXY_DAEMON]: "basepad's shared Neon proxy",
	[APP_DAEMON]: "the app's daemon",
};

const NAME = /^[a-z][a-z0-9_-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const Schema = z.strictObject({
	preset: z.enum(PRESETS).default("next"),
	app: z
		.strictObject({ run: z.string().min(1, "`run` is the command that starts the app") })
		.optional(),
	services: z
		.record(
			z.string().regex(NAME, "a service name is lowercase letters, digits, `-` and `_`"),
			z.strictObject({
				type: z.enum(SERVICE_TYPES as [ServiceType, ...ServiceType[]]).optional(),
				databases: z
					.array(
						z.string().regex(NAME, "a database name is lowercase letters, digits, `-` and `_`"),
					)
					.min(1)
					.optional(),
				copy: z.enum(COPIES).optional(),
			}),
		)
		.default({}),
	rename: z
		.record(z.string(), z.string().regex(ENV_KEY, "a variable name is letters, digits and `_`"))
		.default({}),
});

/** The project's `basepad.toml`, or an empty config when it has none. */
export async function loadConfig(projectDir: string): Promise<ProjectConfig> {
	const text = await readConfigText(projectDir);
	return text === undefined ? { preset: "next", services: [], rename: {} } : parseConfig(text);
}

function parseConfig(text: string): ProjectConfig {
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (error) {
		throw new BasepadError(`${CONFIG_FILE} isn't valid TOML: ${(error as Error).message}`);
	}
	const parsed = Schema.safeParse(raw);
	if (!parsed.success) {
		throw new BasepadError(`${CONFIG_FILE} is invalid:\n${z.prettifyError(parsed.error)}`);
	}
	const services = Object.entries(parsed.data.services).map(([name, service]): ServiceConfig => {
		const type = service.type ?? (SERVICE_TYPES as string[]).find((t) => t === name);
		if (type === undefined) {
			throw new BasepadError(
				`${CONFIG_FILE}: service \`${name}\` needs a \`type\` (${SERVICE_TYPES.join(", ")}).`,
			);
		}
		const copies: readonly Copy[] = CATALOGUE[type as ServiceType].copies;
		if (service.copy !== undefined && !copies.includes(service.copy)) {
			throw new BasepadError(
				`${CONFIG_FILE}: service \`${name}\` can't use \`copy = "${service.copy}"\`. A ${type} service can use: ${copies.join(", ")}.`,
			);
		}
		if (service.databases !== undefined && type !== "postgres" && type !== "postgres-neon") {
			throw new BasepadError(
				`${CONFIG_FILE}: service \`${name}\` is ${type}; only a postgres or postgres-neon service has \`databases\`.`,
			);
		}
		if (Object.hasOwn(RESERVED, name)) {
			throw new BasepadError(
				`${CONFIG_FILE}: \`${name}\` is the name of ${RESERVED[name]}; choose another.`,
			);
		}
		return {
			name,
			type: type as ServiceType,
			databases: service.databases,
			copy: service.copy ?? (copies[0] as Copy),
		};
	});
	return {
		preset: parsed.data.preset,
		app: parsed.data.app,
		services,
		rename: parsed.data.rename,
	};
}

/**
 * Declares a service in the project's `basepad.toml`, and sets its preset, creating the file if
 * needed. The file is edited as text, so the project's own comments and layout stay.
 */
export async function declareService(
	projectDir: string,
	service: { name: string; type: ServiceType },
	preset: Preset | undefined,
): Promise<void> {
	let text = (await readConfigText(projectDir)) ?? "";
	const before = text;
	const config = text === "" ? undefined : parseConfig(text);

	if (text === "") {
		text = `# This project's services. See https://github.com/Aysnc-Labs/basepad#configuration\npreset = "${preset ?? "next"}"\n`;
	} else if (preset !== undefined && config?.preset !== preset) {
		const line = /^preset\s*=.*$/m;
		text = line.test(text)
			? text.replace(line, `preset = "${preset}"`)
			: `preset = "${preset}"\n${text}`;
	}

	const existing = config?.services.find((s) => s.name === service.name);
	if (existing && existing.type !== service.type) {
		throw new BasepadError(
			`This project already has a service named \`${service.name}\`, of type ${existing.type}. Pick another with \`--name\`.`,
		);
	}
	if (!existing) {
		const separator = text.endsWith("\n") ? "" : "\n";
		text += `${separator}\n[services.${service.name}]\ntype = "${service.type}"\n`;
	}

	if (text === before) return;
	parseConfig(text);
	await writeFile(join(projectDir, CONFIG_FILE), text);
}

export async function hasConfig(projectDir: string): Promise<boolean> {
	return (await readConfigText(projectDir)) !== undefined;
}

async function readConfigText(projectDir: string): Promise<string | undefined> {
	try {
		return await readFile(join(projectDir, CONFIG_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
