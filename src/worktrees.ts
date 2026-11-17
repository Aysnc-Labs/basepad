import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { CONFIG_FILE, type Project } from "./config.ts";
import { BasepadError, exec, must } from "./internal/exec.ts";
import { nextSuffix, worktreeFolder } from "./layout.ts";

export type Checkout =
	| { suffix?: undefined }
	| {
			suffix: string;
			main: string;
	  };

export async function checkoutOf(root: string): Promise<Checkout> {
	const top = await toplevel(root);
	if (top === undefined) return {};
	const [first] = await checkoutsOf(top);
	if (first === undefined || first.path === top) return {};
	return { suffix: basename(top), main: join(first.path, relative(top, root)) };
}

export function checkedOut(suffix: string, root: string): string {
	return `Worktree ${suffix} is checked out at ${root}`;
}

export function checkedOutIn(lines: readonly string[]): string | undefined {
	for (const line of lines) {
		const suffix = /^Worktree (\S+) is checked out at /.exec(line)?.[1];
		if (suffix !== undefined) return suffix;
	}
	return undefined;
}

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
	// For a branch only a remote has, git makes a local one tracking it: https://git-scm.com/docs/git-worktree
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

export async function clonePaths(from: string, to: string, paths: string[]): Promise<string[]> {
	const notes: string[] = [];
	for (const path of paths) {
		const source = join(from, path);
		const target = join(to, path);
		if (!existsSync(source)) {
			notes.push(`Skipped \`${path}\` from \`worktrees.clone\`: main has none.`);
			continue;
		}
		const folder = (await stat(source)).isDirectory();
		await mkdir(folder ? target : dirname(target), { recursive: true });
		const args = folder ? [`${source}/.`, `${target}/`] : [source, target];
		await copyOnWrite(args);
	}
	return notes;
}

async function copyOnWrite(args: string[]): Promise<void> {
	if (process.platform !== "darwin") {
		await must("cp", ["-R", "--reflink=auto", ...args]);
		return;
	}
	const cloned = await exec("cp", ["-c", "-R", ...args]);
	if (cloned.code !== 0) await must("cp", ["-R", ...args]);
}

export async function runSetup(
	dir: string,
	commands: string[],
	say: (line: string) => void,
): Promise<void> {
	const env = { ...process.env };
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

export interface Listed {
	suffix: string;
	path: string;
	root: string;
	branch?: string;
	present: boolean;
}

export async function listWorktrees(main: Project): Promise<Listed[]> {
	const top = await toplevel(main.root);
	if (top === undefined) return [];
	return (await checkoutsOf(top)).slice(1).map(({ path, branch }) => ({
		suffix: basename(path),
		path,
		root: join(path, relative(top, main.root)),
		...(branch === undefined ? {} : { branch }),
		present: existsSync(path),
	}));
}

export async function mainBranch(main: Project): Promise<string | undefined> {
	const top = await toplevel(main.root);
	if (top === undefined) return undefined;
	return (await checkoutsOf(top))[0]?.branch;
}

export async function hasChanges(path: string): Promise<boolean> {
	return (await git(path, ["status", "--porcelain"])).trim() !== "";
}

export async function removeCheckout(main: Project, path: string): Promise<void> {
	const top = await toplevel(main.root);
	if (top === undefined) return;
	await git(top, ["worktree", "remove", "--force", path]);
}

async function toplevel(dir: string): Promise<string | undefined> {
	const out = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(
		() => undefined,
	);
	if (out === undefined || out.code !== 0) return undefined;
	return realpath(out.stdout.trim());
}

async function checkoutsOf(top: string): Promise<{ path: string; branch?: string }[]> {
	const out = await git(top, ["worktree", "list", "--porcelain", "-z"]);
	const checkouts: { path: string; branch?: string }[] = [];
	// Each checkout is a run of fields, ended by an empty one: https://git-scm.com/docs/git-worktree#_porcelain_format
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
