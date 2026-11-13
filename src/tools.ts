import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BasepadError, must } from "./internal/exec.ts";

/** A tool mise has installed: where it lives and where its programs are. */
export interface Tool {
	/** The install folder, for tools whose files basepad places or reads. */
	dir: string;
	/** The path of one of the tool's programs. */
	bin(program: string): string;
}

/**
 * Installs `tool@version` through mise when it is missing, and locates it. Runs mise from `cwd`
 * (basepad's home), so no project's mise config is read or needs trusting.
 */
export async function install(tool: string, version: string, cwd: string): Promise<Tool> {
	const spec = `${tool}@${version}`;
	await mkdir(cwd, { recursive: true });
	// Always, not only when `mise where` fails: `where` answers for an install still in progress
	// (another basepad installing at the same moment), and `install` waits on mise's lock for it.
	// mise fails an install when it cannot fetch a skill the tool declares; basepad needs only the tool.
	await must("mise", ["install", "--quiet", spec], {
		cwd,
		env: { ...process.env, MISE_SKILLS_FETCH: "false" },
	});
	const dir = (await must("mise", ["where", spec], { cwd })).trim();
	const paths = (await must("mise", ["bin-paths", spec], { cwd })).split("\n").filter(Boolean);
	return {
		dir,
		bin(program) {
			for (const path of paths) {
				const file = join(path, program);
				if (existsSync(file)) return file;
			}
			throw new BasepadError(`mise's ${spec} has no \`${program}\` in ${paths.join(", ")}.`);
		},
	};
}
