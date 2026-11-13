import type { Project } from "./config.ts";
import { BasepadError } from "./internal/exec.ts";

/**
 * Every fact derived from the project's description: domains and database names now; ports and
 * paths in basepad's home as later commands need them. The only place such names are computed. It
 * rejects names past their limits with the reason, and never truncates.
 */
export interface Layout {
	apps: Record<string, { host: string; url: string }>;
	services: Record<string, { database: string }>;
}

/** A DNS label's limit, in characters. */
const LABEL_MAX = 63;
/** Postgres silently truncates identifiers past this many bytes. */
const IDENTIFIER_MAX = 63;

export function layout(project: Pick<Project, "file" | "name" | "apps" | "services">): Layout {
	const fail = (reason: string): never => {
		throw new BasepadError(`${project.file}: ${reason}`);
	};
	const { name } = project;
	if (name.length > LABEL_MAX) {
		fail(`\`name\` is ${name.length} characters; a domain label allows ${LABEL_MAX}.`);
	}
	const apps: Layout["apps"] = {};
	for (const key of Object.keys(project.apps)) {
		if (key.length > LABEL_MAX) {
			fail(`app \`${key}\` is ${key.length} characters; a domain label allows ${LABEL_MAX}.`);
		}
		const host = `${key}.${name}.localhost`;
		apps[key] = { host, url: `https://${host}` };
	}
	const services: Layout["services"] = {};
	for (const key of Object.keys(project.services)) {
		const database = `${name}_${key}`.replaceAll("-", "_");
		const bytes = Buffer.byteLength(database);
		if (bytes > IDENTIFIER_MAX) {
			fail(
				`\`name\` and service \`${key}\` make the database name "${database}", which is ${bytes} bytes; Postgres allows ${IDENTIFIER_MAX}. Shorten \`name\` or the service key.`,
			);
		}
		services[key] = { database };
	}
	return { apps, services };
}
