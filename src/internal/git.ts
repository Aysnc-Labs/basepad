import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { BasepadError, exec, must } from "./exec.ts";

/** Where `cwd` sits in its git repo: the checkout it is in, and the repo's main checkout. */
export interface Checkout {
	/** The root of the checkout holding `cwd`: main's, or a worktree's. */
	root: string;
	/** The root of the repo's main checkout. */
	mainRoot: string;
	/** `cwd`, relative to `root`: where the project sits in a monorepo, or `""`. */
	sub: string;
}

export async function checkout(cwd: string): Promise<Checkout> {
	const dir = await realpath(cwd);
	const out = await exec(
		"git",
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
		{ cwd: dir },
	);
	if (out.code !== 0) throw new BasepadError(`${dir} isn't in a git repo.`);
	const [top, common] = out.stdout.trim().split("\n") as [string, string];
	if (basename(common) !== ".git") {
		throw new BasepadError("basepad's worktrees need a repo with a main checkout, not a bare one.");
	}
	const root = await realpath(top);
	return { root, mainRoot: await realpath(dirname(common)), sub: relative(root, dir) };
}

/** Checks out branch `branch` at `path`, creating the branch from main's `HEAD` if it's new. */
export async function addWorktree(mainRoot: string, path: string, branch: string): Promise<void> {
	const exists =
		(
			await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
				cwd: mainRoot,
			})
		).code === 0;
	const args = exists ? [path, branch] : ["-b", branch, path];
	await must("git", ["worktree", "add", "--quiet", ...args], { cwd: mainRoot });
}

/** Removes the worktree at `path`, or forgets it if it is already gone. Its branch stays. */
export async function removeWorktree(mainRoot: string, path: string): Promise<void> {
	const listed = await must("git", ["worktree", "list", "--porcelain"], { cwd: mainRoot });
	if (!listed.split("\n").includes(`worktree ${path}`)) return;
	const out = await exec("git", ["worktree", "remove", "--force", "--force", path], {
		cwd: mainRoot,
	});
	if (out.code !== 0) await must("git", ["worktree", "prune"], { cwd: mainRoot });
}

/** Whether the checkout at `root` has changes git would lose: modified or untracked, not ignored. */
export async function hasChanges(root: string): Promise<boolean> {
	return (await must("git", ["status", "--porcelain"], { cwd: root })).trim() !== "";
}

/**
 * The paths in main that `.worktreeinclude` names and git ignores, as Claude Code reads it: files,
 * or whole directories when every file in them is included. Tracked files come with the checkout.
 */
export async function includedPaths(mainRoot: string): Promise<string[]> {
	const file = join(mainRoot, ".worktreeinclude");
	if ((await readFile(file, "utf8").catch(() => undefined)) === undefined) return [];
	const listed = await must(
		"git",
		["ls-files", "-z", "--others", "--ignored", `--exclude-from=${file}`, "--directory"],
		{ cwd: mainRoot },
	);
	if (listed === "") return [];
	// check-ignore exits 1 when none of them is ignored.
	const ignored = await exec("git", ["check-ignore", "-z", "--stdin"], {
		cwd: mainRoot,
		input: listed,
	});
	if (ignored.code > 1) {
		throw new BasepadError(`\`git check-ignore\` failed:\n${ignored.stderr.trim()}`);
	}
	return ignored.stdout
		.split("\0")
		.filter(Boolean)
		.map((path) => path.replace(/\/$/, ""));
}
