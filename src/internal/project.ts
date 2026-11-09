import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Home } from "./home.ts";
import { NEON_PROXY_DAEMON } from "./neon.ts";
import { POSTGRES_DAEMON } from "./postgres.ts";
import type { Project } from "./records.ts";
import { MISE_MIN_VERSION, PITCHFORK_VERSION } from "./versions.ts";

/** Where basepad keeps a project's mise config: conf.d, the lowest-precedence file, so the project's own config wins. */
export function confFile(projectDir: string): string {
	return join(projectDir, ".config", "mise", "conf.d", "basepad.toml");
}

/**
 * Writes the project's references to the home project's shared daemons. A reference takes only
 * `project` and `name`; the daemon's settings live in the home project.
 */
export async function writeProjectConfig(
	projectDir: string,
	project: Project,
	home: Home,
): Promise<void> {
	const lines = [
		"# Written by basepad. Change services with `basepad add`; edits here are overwritten.",
		`min_version = "${MISE_MIN_VERSION}"`,
		"",
		"[settings]",
		"experimental = true",
		"",
		"[tools]",
		`pitchfork = "${PITCHFORK_VERSION}"`,
	];
	const reference = (name: string, daemon: string) =>
		lines.push(
			"",
			`[daemons.${name}]`,
			`project = ${JSON.stringify(home.dir)}`,
			`name = "${daemon}"`,
		);
	for (const name of Object.keys(project.services)) reference(name, POSTGRES_DAEMON);
	// One proxy for the project, however many of its databases go through it.
	if (Object.values(project.services).some((s) => s.type === "postgres-neon")) {
		reference(NEON_PROXY_DAEMON, NEON_PROXY_DAEMON);
	}
	const file = confFile(projectDir);
	const text = `${lines.join("\n")}\n`;
	if ((await readFile(file, "utf8").catch(() => "")) === text) return;
	await mkdir(join(projectDir, ".config", "mise", "conf.d"), { recursive: true });
	await writeFile(file, text);
}
