import { constants } from "node:fs";
import { access, cp, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BasepadError } from "./exec.ts";
import { checkout } from "./git.ts";

/**
 * Copies each path (relative to both roots) from `fromRoot` to `toRoot`, file by file, as
 * copy-on-write clones where the filesystem supports them (APFS, Btrfs, XFS), else as plain
 * copies. Symlinks are copied as they are, so a relative link still points inside the copy.
 */
export async function copyPaths(fromRoot: string, toRoot: string, paths: string[]): Promise<void> {
	for (const path of paths) {
		await cp(join(fromRoot, path), join(toRoot, path), {
			recursive: true,
			force: true,
			verbatimSymlinks: true,
			mode: constants.COPYFILE_FICLONE,
		});
	}
}

/**
 * `basepad clone <path>…`: copies paths from the repo's main checkout into the worktree that holds
 * `cwd`, at the same place. Paths are relative to `cwd`.
 */
export async function clone(cwd: string, paths: string[]): Promise<string[]> {
	if (paths.length === 0) throw new BasepadError("`basepad clone` needs a path to copy from main.");
	const here = await checkout(cwd);
	if (here.root === here.mainRoot) {
		throw new BasepadError("This is main's checkout; run `basepad clone` in a worktree.");
	}
	const dir = await realpath(cwd);
	const lines: string[] = [];
	const rels: string[] = [];
	for (const path of paths) {
		const rel = relative(here.root, resolve(dir, path));
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
			throw new BasepadError(`\`${path}\` isn't inside this worktree.`);
		}
		await access(join(here.mainRoot, rel)).catch(() => {
			throw new BasepadError(`Main has no \`${rel}\` to clone.`);
		});
		rels.push(rel);
	}
	await copyPaths(here.mainRoot, here.root, rels);
	for (const rel of rels) lines.push(`Cloned ${rel} from main.`);
	return lines;
}
