import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { CONFIG_FILE, type Project } from "./config.ts";
import { BasepadError, exec, must } from "./internal/exec.ts";
import { nextSuffix, worktreeFolder } from "./layout.ts";

/**
 * Worktrees: environments made from a main, each in its own git worktree. Everything about them is
 * asked from git (which checkouts exist, their folders, their suffixes), so basepad keeps no list.
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
	const [first] = await checkoutsOf(top);
	if (first === undefined || first.path === top) return {};
	return { suffix: basename(top), main: join(first.path, relative(top, root)) };
}

/**
 * What `worktree add` prints as soon as its git worktree is there, before its setup runs; its errors
 * after that end with it too. An addition killed partway is known to have made `suffix` by it.
 */
export function checkedOut(suffix: string, root: string): string {
	return `Worktree ${suffix} is checked out at ${root}`;
}

/** The suffix `lines` (`worktree add`'s output) say was checked out, if any. */
export function checkedOutIn(lines: readonly string[]): string | undefined {
	for (const line of lines) {
		const suffix = /^Worktree (\S+) is checked out at /.exec(line)?.[1];
		if (suffix !== undefined) return suffix;
	}
	return undefined;
}

/**
 * Checks out a new worktree of `main` (a project in git's main checkout), named `<prefix>-<n>` with
 * the lowest number no worktree, branch or folder has. It is on `branch` when that exists, here or
 * on a remote; else on a new branch of that name, or of the suffix, from main's `HEAD`. Returns the
 * suffix, the branch and the worktree's folder for the config.
 */
export async function checkOutWorktree(
	main: Project,
	branch?: string,
): Promise<{ suffix: string; branch: string; root: string }> {
	const top = await toplevel(main.root);
	if (top === undefined) {
		throw new BasepadError(
			`A worktree is a git worktree, and ${main.root} is not in a git repository.`,
		);
	}
	const dir = worktreeFolder(main, top);
	const branches = (await git(top, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
		.split("\n")
		.filter(Boolean);
	const folders = existsSync(dir) ? await readdir(dir) : [];
	const checkouts = (await checkoutsOf(top)).map(({ path }) => basename(path));
	const suffix = nextSuffix(main.worktrees.prefix, [...branches, ...folders, ...checkouts]);
	const path = worktreeFolder(main, top, suffix);
	const on = branch ?? suffix;
	// For a branch only a remote has, git makes a local one tracking it.
	const exists =
		branch !== undefined &&
		(await git(top, [
			"for-each-ref",
			"--format=%(refname)",
			`refs/heads/${on}`,
			`refs/remotes/*/${on}`,
		])) !== "";
	await git(top, [
		"worktree",
		"add",
		"--quiet",
		...(exists ? [path, on] : ["-b", on, path, "HEAD"]),
	]);
	const root = join(await realpath(path), relative(top, main.root));
	if (!existsSync(join(root, CONFIG_FILE))) {
		throw new BasepadError(
			`The worktree at ${path} has no ${relative(top, join(main.root, CONFIG_FILE))}: commit it in main, then remove this worktree with \`git worktree remove ${path}\` and try again.`,
		);
	}
	return { suffix, branch: on, root };
}

/**
 * Copies each of `paths` (relative to both folders) from main's folder to a worktree's, file by
 * file, copy-on-write where the filesystem can (APFS, btrfs, XFS) and plainly otherwise. Never a
 * link: a worktree's writes must not reach main's files. Returns a note for each path main lacks.
 * The system's `cp` does it, which is faster than Node's own on a large `node_modules`.
 */
export async function clonePaths(from: string, to: string, paths: string[]): Promise<string[]> {
	const notes: string[] = [];
	for (const path of paths) {
		const source = join(from, path);
		const target = join(to, path);
		if (!existsSync(source)) {
			notes.push(`Skipped \`${path}\` from \`worktrees.clone\`: main has none.`);
			continue;
		}
		// A folder's contents go into the target folder, which may exist (with tracked files).
		const folder = (await stat(source)).isDirectory();
		await mkdir(folder ? target : dirname(target), { recursive: true });
		const args = folder ? [`${source}/.`, `${target}/`] : [source, target];
		await copyOnWrite(args);
	}
	return notes;
}

/** `cp -R` with copy-on-write where the filesystem can; symlinks are copied as they are. */
async function copyOnWrite(args: string[]): Promise<void> {
	if (process.platform !== "darwin") {
		await must("cp", ["-R", "--reflink=auto", ...args]);
		return;
	}
	// macOS's `cp -c` clones, and fails on a volume that cannot.
	const cloned = await exec("cp", ["-c", "-R", ...args]);
	if (cloned.code !== 0) await must("cp", ["-R", ...args]);
}

/**
 * Runs each setup command in order in `dir` with the developer's own PATH, saying each before it
 * runs. The first that fails throws with its output, and the rest do not run.
 */
export async function runSetup(
	dir: string,
	commands: string[],
	say: (line: string) => void,
): Promise<void> {
	const env = { ...process.env };
	// The launcher moved basepad onto mise's Node; the project's commands get the PATH they had.
	if (env.BASEPAD_PATH) env.PATH = env.BASEPAD_PATH;
	delete env.BASEPAD_PATH;
	for (const command of commands) {
		say(`Running \`${command}\``);
		const out = await exec("sh", ["-c", command], { cwd: dir, env });
		if (out.code === 0) continue;
		const output = `${out.stdout}${out.stderr}`.trimEnd();
		throw new BasepadError(
			`Setup command \`${command}\` failed (exit ${out.code}). Its output:\n${(output || "(none)").replace(/^/gm, "  ")}`,
		);
	}
}

/** One worktree of main, as git lists it. */
export interface Listed {
	/** Its suffix: the git worktree's folder name. */
	suffix: string;
	/** The git worktree's folder. */
	path: string;
	/** Its folder for the config: the same path inside it as main's config has in main. */
	root: string;
	/** Its branch; none when detached. */
	branch?: string;
	/** Whether its folder still exists. */
	present: boolean;
}

/** Every worktree of `main` (a project in git's main checkout), as git lists them; none outside git. */
export async function listWorktrees(main: Project): Promise<Listed[]> {
	const top = await toplevel(main.root);
	if (top === undefined) return [];
	// Main's own checkout comes first.
	return (await checkoutsOf(top)).slice(1).map(({ path, branch }) => ({
		suffix: basename(path),
		path,
		root: join(path, relative(top, main.root)),
		...(branch === undefined ? {} : { branch }),
		present: existsSync(path),
	}));
}

/** Main's own branch, as git lists it; none when detached or outside git. */
export async function mainBranch(main: Project): Promise<string | undefined> {
	const top = await toplevel(main.root);
	if (top === undefined) return undefined;
	return (await checkoutsOf(top))[0]?.branch;
}

/** Whether a git worktree's folder has changes git would lose: modified, staged or untracked files. */
export async function hasChanges(path: string): Promise<boolean> {
	return (await git(path, ["status", "--porcelain"])).trim() !== "";
}

/** Removes a git worktree's folder and git's record of it, changes and all; its branch stays. */
export async function removeCheckout(main: Project, path: string): Promise<void> {
	const top = await toplevel(main.root);
	if (top === undefined) return;
	await git(top, ["worktree", "remove", "--force", path]);
}

/** The git repository's top folder containing `dir`, real; none outside git. */
async function toplevel(dir: string): Promise<string | undefined> {
	const out = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(
		() => undefined,
	);
	if (out === undefined || out.code !== 0) return undefined;
	return realpath(out.stdout.trim());
}

/** Every checkout of the repository as git lists it, main's first: its real folder and branch. */
async function checkoutsOf(top: string): Promise<{ path: string; branch?: string }[]> {
	const out = await git(top, ["worktree", "list", "--porcelain", "-z"]);
	const checkouts: { path: string; branch?: string }[] = [];
	// Each checkout is a run of fields, ended by an empty one.
	for (const record of out.split("\0\0")) {
		const fields = record.split("\0");
		const path = fields.find((f) => f.startsWith("worktree "))?.slice("worktree ".length);
		const branch = fields.find((f) => f.startsWith("branch "))?.slice("branch refs/heads/".length);
		if (path === undefined) continue;
		const real = await realpath(path).catch(() => path);
		checkouts.push({ path: real, ...(branch === undefined ? {} : { branch }) });
	}
	return checkouts;
}

function git(cwd: string, args: string[]): Promise<string> {
	return must("git", args, { cwd });
}
