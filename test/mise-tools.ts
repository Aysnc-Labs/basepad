import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		miseDataDir: string;
		miseCacheDir: string;
	}
}

export const PROJECT_MISE_TOML = join(import.meta.dirname, "project-mise.toml");

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const temporary: string[] = [];
	const folder = async (from: string | undefined, name: string) => {
		if (from) return from;
		const made = await mkdtemp(join(tmpdir(), `basepad-test-${name}-`));
		temporary.push(made);
		await chmod(made, 0o755);
		return made;
	};
	const dataDir = await folder(process.env.MISE_DATA_DIR, "mise-data");
	const cacheDir = await folder(process.env.MISE_CACHE_DIR, "mise-cache");
	const scratch = await mkdtemp(join(tmpdir(), "basepad-test-tools-"));
	try {
		await copyFile(PROJECT_MISE_TOML, join(scratch, "mise.toml"));
		execFileSync("mise", ["install"], {
			cwd: scratch,
			stdio: "inherit",
			env: {
				...process.env,
				MISE_DATA_DIR: dataDir,
				MISE_CACHE_DIR: cacheDir,
				MISE_CONFIG_DIR: join(scratch, "config"),
				MISE_STATE_DIR: join(scratch, "state"),
				MISE_TRUSTED_CONFIG_PATHS: scratch,
			},
		});
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
	project.provide("miseDataDir", dataDir);
	project.provide("miseCacheDir", cacheDir);
	return async () => {
		for (const dir of temporary) await rm(dir, { recursive: true, force: true });
	};
}
