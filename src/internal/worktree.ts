import { access, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { copyPaths } from "./clone.ts";
import { CONFIG_FILE, hasConfig, loadConfig } from "./config.ts";
import { readEnvBlock, removeEnvBlock } from "./envfile.ts";
import { BasepadError, exec } from "./exec.ts";
import {
	checkout,
	addWorktree as gitAddWorktree,
	removeWorktree as gitRemoveWorktree,
	hasChanges,
	includedPaths,
} from "./git.ts";
import { openHome, withHome } from "./home.ts";
import { HOOKS, type HookContext, runHook } from "./hooks.ts";
import { labelFile, serve, stopApp, syncHosts } from "./names.ts";
import { canListen } from "./ports.ts";
import { startPostgres } from "./postgres.ts";
import { ENV_FILES } from "./presets.ts";
import { confFile } from "./project.ts";
import type { Project, Records } from "./records.ts";
import { bringUp, type Up } from "./up.ts";

type Worktree = NonNullable<Project["worktree"]>;

/** A worktree's name: a git branch name that is also safe in a path, a database and a mail tag. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_NAME = 40;

export interface AddOptions {
	cwd: string;
	name: string;
	/** Where to check it out. Default: beside main, as `<main>-<name>`. */
	path?: string;
}

/**
 * `basepad worktree add <name>`: checks out branch `<name>` (new from main's `HEAD`, or existing)
 * as a git worktree, copies the files `.worktreeinclude` lists, brings the project up there with
 * its own databases, Redis, port and mail tag, then runs the project's `basepad:post-create` and
 * `basepad:post-start` tasks.
 */
export async function addWorktree(options: AddOptions): Promise<string[]> {
	const { name } = options;
	if (!NAME.test(name) || name.includes("..") || name.endsWith("/") || name.length > MAX_NAME) {
		throw new BasepadError(
			`\`${name}\` isn't a valid worktree name: use letters, digits, \`.\`, \`_\`, \`-\` and \`/\`, up to ${MAX_NAME} long.`,
		);
	}
	const here = await checkout(options.cwd);
	const mainProject = join(here.mainRoot, here.sub);
	if (findWorktrees((await openHome()).records, here.mainRoot, name).length > 0) {
		throw new BasepadError(
			`This repo already has a worktree named ${name}. Remove it with \`basepad worktree remove ${name}\`.`,
		);
	}
	const target = options.path
		? resolve(options.cwd, options.path)
		: join(dirname(here.mainRoot), `${basename(here.mainRoot)}-${name.replaceAll("/", "-")}`);
	if (await exists(target)) throw new BasepadError(`${target} already exists.`);

	await gitAddWorktree(here.mainRoot, target, name);
	const root = await realpath(target);
	const projectDir = join(root, here.sub);
	const lines = [`Checked out ${name} at ${root}.`];
	const included = await includedPaths(here.mainRoot);
	try {
		await copyPaths(here.mainRoot, root, included);
	} catch (error) {
		// Nothing but the checkout exists yet, so undo it rather than leave a worktree basepad can't remove.
		await gitRemoveWorktree(here.mainRoot, root);
		throw error;
	}
	if (included.length > 0) lines.push(`Copied from main: ${included.join(", ")}.`);

	const worktree: Worktree = { name, main: mainProject, root, mainRoot: here.mainRoot };
	const result = await withHome(async (home) => {
		// Main's services run and its databases exist, so there is something to copy.
		if (await hasConfig(mainProject)) await bringUp(home, mainProject);
		home.records.projects[projectDir] = { services: {}, worktree };
		await home.save();
		return bringUp(home, projectDir);
	});
	lines.push(...result.lines);

	const context = hookContext(worktree, result);
	for (const hook of [HOOKS.postCreate, HOOKS.postStart]) {
		try {
			if (await runHook(hook, projectDir, context)) lines.push(`Ran ${hook}.`);
		} catch (error) {
			for (const line of lines) console.log(line);
			throw new BasepadError(
				`${(error as Error).message} Worktree ${name} is at ${root} with its services; fix the task and run \`mise run ${hook}\` there, or \`basepad worktree remove ${name}\`.`,
			);
		}
	}
	lines.push(...(await serve(projectDir)));
	lines.push(
		`Worktree ${name} is ready at ${root}, its app on port ${result.vars.PORT ?? result.project.app?.port}.`,
	);
	return lines;
}

/**
 * `basepad up`, worktree-aware: brings the project up, and in a worktree runs the project's
 * `basepad:post-start` task after.
 */
export async function start(cwd: string): Promise<string[]> {
	const projectDir = await realpath(cwd);
	const result = await withHome(async (home) => {
		const worktree = home.records.projects[projectDir]?.worktree;
		if (!worktree && !(await hasConfig(projectDir))) {
			throw new BasepadError(
				`No ${CONFIG_FILE} here. Add a service with \`basepad add <service>\`.`,
			);
		}
		return bringUp(home, projectDir);
	});
	const worktree = result.project.worktree;
	if (worktree && (await runHook(HOOKS.postStart, projectDir, hookContext(worktree, result)))) {
		result.lines.push(`Ran ${HOOKS.postStart}.`);
	}
	result.lines.push(...(await serve(projectDir)));
	return result.lines;
}

export interface RemoveOptions {
	cwd: string;
	name: string;
	/** Remove it even with uncommitted changes, or when its `basepad:pre-remove` task fails. */
	force?: boolean;
}

/**
 * `basepad worktree remove <name>`: runs the project's `basepad:pre-remove` task, stops the
 * worktree's own services, drops its databases, clears its env block and basepad's records of it,
 * then removes the git worktree. Its branch is kept.
 */
export async function removeWorktree(options: RemoveOptions): Promise<string[]> {
	const here = await checkout(options.cwd);
	const found = findWorktrees((await openHome()).records, here.mainRoot, options.name);
	if (found.length === 0) {
		throw new BasepadError(`This repo has no basepad worktree named ${options.name}.`);
	}
	const root = (found[0] as [string, Project & { worktree: Worktree }])[1].worktree.root;
	const present = await exists(root);
	// basepad's own files don't count, committed or not: it rewrites them, and they go with it.
	const ours = await Promise.all(
		found.map(async ([projectDir]) => {
			const sub = relative(root, projectDir);
			const preset = (await exists(projectDir)) ? (await loadConfig(projectDir)).preset : "next";
			return [
				join(sub, ENV_FILES[preset]),
				relative(root, confFile(projectDir)),
				relative(root, labelFile(root)),
			];
		}),
	);
	if (present && !options.force && (await hasChanges(root, ours.flat()))) {
		throw new BasepadError(
			`${root} has uncommitted changes. Commit or stash them, or pass \`--force\` to lose them.`,
		);
	}

	const lines: string[] = [];
	for (const [projectDir, project] of found) {
		if (!(await exists(projectDir))) continue;
		const config = await loadConfig(projectDir);
		const file = join(projectDir, ENV_FILES[config.preset]);
		const vars = await readEnvBlock(file);
		const context = hookContext(project.worktree, { vars, project });
		try {
			if (await runHook(HOOKS.preRemove, projectDir, context))
				lines.push(`Ran ${HOOKS.preRemove}.`);
		} catch (error) {
			if (!options.force) {
				throw new BasepadError(
					`${(error as Error).message} The worktree is unchanged; pass \`--force\` to remove it anyway.`,
				);
			}
			lines.push(`${(error as Error).message} Removing anyway, as asked.`);
		}
	}

	await withHome(async (home) => {
		for (const [projectDir, project] of found) {
			const owned = Object.entries(project.services).filter(
				([, s]) => !("shared" in s && s.shared),
			);
			for (const [service, record] of owned) {
				if (record.type !== "redis" || !(await exists(projectDir))) continue;
				const stop = await exec("mise", ["daemons", "stop", service], { cwd: projectDir });
				if (stop.code !== 0) lines.push(`Couldn't stop ${service}: ${stop.stderr.trim()}`);
				else lines.push(`Stopped ${service}.`);
			}
			const databases = owned.flatMap(([, s]) =>
				s.type === "postgres" || s.type === "postgres-neon" ? Object.values(s.databases) : [],
			);
			if (databases.length > 0) {
				const server = await startPostgres(home);
				for (const database of databases) await server.dropDatabase(database);
				lines.push(`Dropped ${databases.join(", ")}.`);
			}
			if (await exists(projectDir)) lines.push(...(await stopApp(projectDir)));
			if (await exists(projectDir)) {
				const config = await loadConfig(projectDir);
				await removeEnvBlock(join(projectDir, ENV_FILES[config.preset]));
			}
			delete home.records.projects[projectDir];
			await home.save();
		}
		lines.push(...(await syncHosts(home)));
	});

	await gitRemoveWorktree(here.mainRoot, root);
	lines.push(`Removed worktree ${options.name} (${root}); its branch is kept.`);
	return lines;
}

/** `basepad worktree ls`: this repo's basepad worktrees, with their state, ports and databases. */
export async function listWorktrees(cwd: string): Promise<string> {
	const here = await checkout(cwd);
	const records = (await openHome()).records;
	const rows: string[][] = [];
	for (const [projectDir, project] of findWorktrees(records, here.mainRoot)) {
		const port = project.app?.port;
		const state = !(await exists(projectDir))
			? "missing"
			: port !== undefined && !(await canListen(port))
				? "serving"
				: "ready";
		const databases = Object.values(project.services).flatMap((s) =>
			s.type === "postgres" || s.type === "postgres-neon"
				? Object.values(s.databases).map((db) => (s.shared ? `${db} (shared)` : db))
				: [],
		);
		const redis = Object.values(project.services).flatMap((s) =>
			s.type === "redis" ? [s.shared ? `${s.port} (shared)` : String(s.port)] : [],
		);
		rows.push([
			project.worktree.name,
			state,
			port === undefined ? "-" : String(port),
			redis.join(", ") || "-",
			databases.join(", ") || "-",
			projectDir,
		]);
	}
	if (rows.length === 0) return "No worktrees yet. Make one with `basepad worktree add <name>`.";
	return table([["WORKTREE", "STATE", "PORT", "REDIS", "DATABASES", "PATH"], ...rows]);
}

/** The worktrees basepad made in the repo whose main checkout is `mainRoot`, by project dir. */
function findWorktrees(
	records: Records,
	mainRoot: string,
	name?: string,
): [string, Project & { worktree: Worktree }][] {
	return Object.entries(records.projects).filter(
		(entry): entry is [string, Project & { worktree: Worktree }] => {
			const worktree = entry[1].worktree;
			return (
				worktree !== undefined &&
				worktree.mainRoot === mainRoot &&
				(name === undefined || worktree.name === name)
			);
		},
	);
}

function hookContext(worktree: Worktree, up: Pick<Up, "vars" | "project">): HookContext {
	const port = up.project.app?.port;
	return {
		name: worktree.name,
		path: worktree.root,
		mainPath: worktree.mainRoot,
		vars: { ...up.vars, ...(port === undefined ? {} : { PORT: String(port) }) },
	};
}

function table(rows: string[][]): string {
	const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
	return rows
		.map((row) =>
			row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
		)
		.join("\n");
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
