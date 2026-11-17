import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BasepadError, must } from "./internal/exec.ts";

export interface Tool {
	dir: string;
	bin(program: string): string;
}

export async function install(tool: string, version: string, cwd: string): Promise<Tool> {
	const spec = `${tool}@${version}`;
	await mkdir(cwd, { recursive: true });
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
