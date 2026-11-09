import { realpath } from "node:fs/promises";
import { z } from "zod";
import { BasepadError, exec } from "./exec.ts";
import { checkout } from "./git.ts";
import { openHome } from "./home.ts";
import { addWorktree, removeWorktree } from "./worktree.ts";

/**
 * Claude Code's worktree hooks (https://code.claude.com/docs/en/hooks#worktreecreate): a command
 * hook gets the event as JSON on stdin. `WorktreeCreate` must print the worktree's path as the last
 * line of stdout; `WorktreeRemove` gets that path back as `worktree_path`.
 */
const CreateInput = z.looseObject({ name: z.string().min(1), cwd: z.string().optional() });
const RemoveInput = z.looseObject({
	worktree_path: z.string().min(1),
	cwd: z.string().optional(),
});

async function readInput<T>(schema: z.ZodType<T>, event: string): Promise<T> {
	if (process.stdin.isTTY) {
		throw new BasepadError(`--claude reads Claude Code's ${event} hook input on stdin.`);
	}
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new BasepadError(
			`--claude expects Claude Code's ${event} hook input, as JSON, on stdin.`,
		);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new BasepadError(
			`Claude Code's ${event} hook input is missing fields:\n${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data;
}

/**
 * `worktree add --claude`: makes the worktree the hook input names, from the session's directory,
 * and resolves to its absolute path. Progress goes to stderr; the caller prints the path.
 */
export async function claudeCreate(cwd: string): Promise<string> {
	const input = await readInput(CreateInput, "WorktreeCreate");
	const from = input.cwd ?? cwd;
	for (const line of await addWorktree({ cwd: from, name: input.name })) console.error(line);
	const { mainRoot } = await checkout(from);
	const record = Object.values((await openHome()).records.projects).find(
		(p) => p.worktree?.mainRoot === mainRoot && p.worktree.name === input.name,
	);
	if (!record?.worktree) throw new BasepadError(`basepad has no record of ${input.name}.`);
	return record.worktree.root;
}

/**
 * `worktree remove --claude`: removes the worktree at the hook input's `worktree_path`, as
 * `worktree remove --force` does, since Claude Code has already asked before discarding work. Then
 * deletes its branch, unless the branch has commits main's checkout doesn't.
 */
export async function claudeRemove(): Promise<string[]> {
	const input = await readInput(RemoveInput, "WorktreeRemove");
	const path = await realpath(input.worktree_path).catch(() => input.worktree_path);
	const found = Object.values((await openHome()).records.projects).find(
		(p) => p.worktree?.root === path,
	)?.worktree;
	if (!found) throw new BasepadError(`basepad didn't make a worktree at ${input.worktree_path}.`);

	const lines = await removeWorktree({ cwd: found.mainRoot, name: found.name, force: true });
	// `-d` refuses a branch that isn't merged into main's HEAD (or its upstream), so no commit is lost.
	const branch = await exec("git", ["branch", "--delete", found.name], {
		cwd: found.mainRoot,
		env: { ...process.env, LC_ALL: "C" }, // its messages, below, in English
	});
	if (branch.code === 0) {
		lines.push(`Deleted branch ${found.name}.`);
	} else if (/not fully merged/.test(branch.stderr)) {
		lines.push(
			`Kept branch ${found.name}: it has commits main doesn't. Delete it with \`git branch -D ${found.name}\` once you're done with them.`,
		);
	} else if (!/not found/.test(branch.stderr)) {
		lines.push(`Couldn't delete branch ${found.name}: ${branch.stderr.trim()}`);
	}
	return lines;
}
