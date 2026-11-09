import { realpath } from "node:fs/promises";
import { declareService, SERVICE_TYPES, type ServiceType } from "./config.ts";
import { BasepadError } from "./exec.ts";
import { PRESETS, type Preset } from "./presets.ts";
import { up } from "./up.ts";

export interface AddOptions {
	cwd: string;
	services: string[];
	/** The service's name, when adding one service. */
	name?: string;
	preset?: string;
}

/**
 * `basepad add`: declares services in the project's `basepad.toml`, then brings the project up,
 * so they run and their variables are in the env file.
 */
export async function add(options: AddOptions): Promise<string[]> {
	if (options.services.length === 0) throw new BasepadError("`basepad add` needs a service.");
	if (options.name !== undefined && options.services.length > 1) {
		throw new BasepadError("`--name` names one service; add the others separately.");
	}
	const services = options.services.map((service) => {
		if (!(SERVICE_TYPES as string[]).includes(service)) {
			throw new BasepadError(
				`Unknown service \`${service}\`. basepad can add: ${SERVICE_TYPES.join(", ")}.`,
			);
		}
		const type = service as ServiceType;
		const name = options.name ?? type;
		if (!/^[a-z][a-z0-9_-]*$/.test(name) || name.includes("--")) {
			throw new BasepadError(
				`\`${name}\` isn't a valid service name: use lowercase letters, digits, \`-\` and \`_\`, starting with a letter.`,
			);
		}
		return { name, type };
	});
	if (options.preset !== undefined && !(PRESETS as readonly string[]).includes(options.preset)) {
		throw new BasepadError(`Unknown preset \`${options.preset}\`. Presets: ${PRESETS.join(", ")}.`);
	}

	const projectDir = await realpath(options.cwd);
	for (const service of services) {
		await declareService(projectDir, service, options.preset as Preset | undefined);
	}
	return up(projectDir);
}
