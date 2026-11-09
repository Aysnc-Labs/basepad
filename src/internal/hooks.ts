import { spawn } from "node:child_process";
import { z } from "zod";
import { BasepadError, must } from "./exec.ts";

/** The mise tasks basepad runs, if the project defines them, at each step of a worktree's life. */
export const HOOKS = {
	postCreate: "basepad:post-create",
	postStart: "basepad:post-start",
	preRemove: "basepad:pre-remove",
} as const;
export type Hook = (typeof HOOKS)[keyof typeof HOOKS];

/** What a hook knows about its worktree, as environment variables. */
export interface HookContext {
	name: string;
	/** The worktree's root, and main's. */
	path: string;
	mainPath: string;
	/** The worktree's env block: every service's URL, under the names the app reads, and `PORT`. */
	vars: Record<string, string>;
}

export function hookEnv(context: HookContext): Record<string, string> {
	return {
		...context.vars,
		BASEPAD_WORKTREE: context.name,
		BASEPAD_WORKTREE_PATH: context.path,
		BASEPAD_MAIN_PATH: context.mainPath,
	};
}

/**
 * Runs the project's mise task `hook` in `dir`, if it defines one, with the worktree's variables.
 * Its output goes to stderr, so basepad's stdout stays its own. Throws if the task fails.
 */
export async function runHook(hook: Hook, dir: string, context: HookContext): Promise<boolean> {
	const tasks = z
		.array(z.looseObject({ name: z.string() }))
		.parse(JSON.parse(await must("mise", ["tasks", "ls", "--json"], { cwd: dir })));
	if (!tasks.some((task) => task.name === hook)) return false;
	const code = await new Promise<number>((resolve, reject) => {
		const child = spawn("mise", ["run", hook], {
			cwd: dir,
			env: { ...process.env, ...hookEnv(context) },
			stdio: ["ignore", 2, 2],
		});
		child.on("error", reject);
		child.on("close", (exit) => resolve(exit ?? 1));
	});
	if (code !== 0) throw new BasepadError(`The project's \`${hook}\` task failed (exit ${code}).`);
	return true;
}
