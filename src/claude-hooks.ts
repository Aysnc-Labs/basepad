import { z } from "zod";
import { BasepadError } from "./internal/exec.ts";

/**
 * Claude Code's worktree hooks (https://code.claude.com/docs/en/hooks#worktreecreate). A command
 * hook gets the event as JSON on standard input, with the session's folder as `cwd`.
 * `WorktreeCreate` adds the `name` asked for and must print the worktree's path as the last line of
 * standard output; `WorktreeRemove` gets that path back as `worktree_path`.
 */
const INPUTS = {
	WorktreeCreate: z.looseObject({ name: z.string().min(1), cwd: z.string().optional() }),
	WorktreeRemove: z.looseObject({ worktree_path: z.string().min(1), cwd: z.string().optional() }),
};

type Event = keyof typeof INPUTS;

/** Reads and checks the hook input for `event` from standard input. */
export async function readHookInput<E extends Event>(
	event: E,
): Promise<z.infer<(typeof INPUTS)[E]>> {
	if (process.stdin.isTTY) {
		throw new BasepadError(`\`--claude\` reads Claude Code's ${event} hook input on stdin.`);
	}
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new BasepadError(
			`\`--claude\` expects Claude Code's ${event} hook input, as JSON, on stdin.`,
		);
	}
	const parsed = INPUTS[event].safeParse(raw);
	if (!parsed.success) {
		throw new BasepadError(
			`Claude Code's ${event} hook input is missing fields:\n${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data as z.infer<(typeof INPUTS)[E]>;
}
