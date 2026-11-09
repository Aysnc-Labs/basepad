import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Home } from "./home.ts";
import { MISE_MIN_VERSION, PITCHFORK_VERSION } from "./versions.ts";

/**
 * Where basepad keeps a project's mise config: conf.d, the lowest-precedence file, so the
 * project's own config wins. It holds machine paths and ports, so it isn't meant to be committed.
 */
export function confFile(projectDir: string): string {
	return join(projectDir, ".config", "mise", "conf.d", "basepad.toml");
}

/**
 * A reference to one of the home project's shared daemons. A reference takes only `project` and
 * `name`; the daemon's settings live in the home project.
 */
export function referenceTable(name: string, home: Home, daemon: string): string {
	return [`[daemons.${name}]`, `project = ${JSON.stringify(home.dir)}`, `name = "${daemon}"`].join(
		"\n",
	);
}

/** Writes the project's conf.d file with these daemon tables: references, or its own daemons. */
export async function writeProjectConfig(projectDir: string, tables: string[]): Promise<void> {
	const lines = [
		"# Written by basepad from basepad.toml. Run `basepad up` to rewrite it; edits here are overwritten.",
		`min_version = "${MISE_MIN_VERSION}"`,
		"",
		"[settings]",
		"experimental = true",
		"",
		"[tools]",
		`pitchfork = "${PITCHFORK_VERSION}"`,
		...tables.flatMap((table) => ["", table]),
	];
	const file = confFile(projectDir);
	const text = `${lines.join("\n")}\n`;
	if ((await readFile(file, "utf8").catch(() => "")) === text) return;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text);
}
