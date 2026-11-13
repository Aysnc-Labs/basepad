import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { CONFIG_FILE, type Project } from "./config.ts";
import { BasepadError, exec, must } from "./internal/exec.ts";
import { nextSuffix } from "./layout.ts";

/**
 * Worktrees: environments made from a main, each in its own git worktree. Everything about them is
 * asked from git (which checkouts exist, their folders, their names), so basepad keeps no list.
 */

/** Where a config's folder sits in git: main, or a worktree of main with its suffix. */
export type Checkout =
	| { suffix?: undefined }
	| {
			/** The git worktree's folder name. */
			suffix: string;
			/** Main's folder for the same config: the same path inside main's checkout. */
			main: string;
	  };

/**
 * Whether `root` (a config's folder) is in a linked git worktree, and if so its suffix and main's
 * matching folder. Outside git, or in git's main checkout, it is main.
 */
export async function checkoutOf(root: string): Promise<Checkout> {
	const top = await toplevel(root);
	if (top === undefined) return {};
	const [first] = await worktreePaths(top);
	if (first === undefined || first === top) return {};
	return { suffix: basename(top), main: join(first, relative(top, root)) };
}

/**
 * Checks out a new worktree of `main` (a project in git's main checkout) on a new branch from its
 * `HEAD`, named `<prefix>-<n>` with the lowest number no worktree, branch or folder has. Returns the
 * suffix and the worktree's folder for the config.
 */
export async function checkOutWorktree(main: Project): Promise<{ suffix: string; root: string }> {
	const top = await toplevel(main.root);
	if (top === undefined) {
		throw new BasepadError(
			`A worktree is a git worktree, and ${main.root} is not in a git repository.`,
		);
	}
	const dir = main.worktrees.dir ?? join(dirname(top), `${main.name}.worktrees`);
	const branches = (await git(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
		.split("\n")
		.filter(Boolean);
	const folders = existsSync(dir) ? await readdir(dir) : [];
	const checkouts = (await worktreePaths(top)).map((path) => basename(path));
	const suffix = nextSuffix(main.worktrees.prefix, [...branches, ...folders, ...checkouts]);
	const path = join(dir, suffix);
	await git(top, ["worktree", "add", "--quiet", "-b", suffix, path, "HEAD"]);
	const root = join(await realpath(path), relative(top, main.root));
	if (!existsSync(join(root, CONFIG_FILE))) {
		throw new BasepadError(
			`The worktree at ${path} has no ${relative(top, join(main.root, CONFIG_FILE))}: commit it in main, then remove this worktree with \`git worktree remove ${path}\` and try again.`,
		);
	}
	return { suffix, root };
}

/** The git repository's top folder containing `dir`, real; none outside git. */
async function toplevel(dir: string): Promise<string | undefined> {
	const out = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(
		() => undefined,
	);
	if (out === undefined || out.code !== 0) return undefined;
	return realpath(out.stdout.trim());
}

/** Every checkout of the repository, main's first, real. */
async function worktreePaths(top: string): Promise<string[]> {
	const out = await git(top, ["worktree", "list", "--porcelain", "-z"]);
	const paths = out
		.split("\0")
		.filter((field) => field.startsWith("worktree "))
		.map((field) => field.slice("worktree ".length));
	return Promise.all(paths.map((path) => realpath(path).catch(() => path)));
}

function git(cwd: string, args: string[]): Promise<string> {
	return must("git", args, { cwd });
}
