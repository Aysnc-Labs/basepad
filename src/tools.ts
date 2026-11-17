import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BasepadError, must } from "./internal/exec.ts";

const TOOL_ONLY_NO_SKILLS = { MISE_SKILLS_FETCH: "false" };

export interface Tool {
	dir: string;
	bin(program: string): string;
}

export async function install(tool: string, version: string, basepadHome: string): Promise<Tool> {
	const spec = `${tool}@${version}`;
	await mkdir(basepadHome, { recursive: true });
	await must("mise", ["install", "--quiet", spec], {
		cwd: basepadHome,
		env: { ...process.env, ...TOOL_ONLY_NO_SKILLS },
	});
	const dir = (await must("mise", ["where", spec], { cwd: basepadHome })).trim();
	const paths = (await must("mise", ["bin-paths", spec], { cwd: basepadHome }))
		.split("\n")
		.filter(Boolean);
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
