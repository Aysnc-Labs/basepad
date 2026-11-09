import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { CONFIG_FILE } from "./config.ts";
import { BasepadError, exec, must } from "./exec.ts";
import { checkout } from "./git.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The `[ci]` table of the repo root's `basepad.toml`: the repo's projects, the paths each one
 * owns, and the commands CI runs for it.
 */
const Schema = z.strictObject({
	/** The branch a local run compares with. Default: origin's default branch, else `main`. */
	base: z.string().min(1).optional(),
	/** Paths every project depends on (a lockfile, CI's own config): a change selects them all. */
	all: z.array(z.string().min(1)).default([]),
	projects: z
		.record(
			z.string().regex(NAME, "a project name is letters, digits, `.`, `_` and `-`"),
			z.strictObject({
				paths: z.array(z.string().min(1)).min(1),
				run: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
			}),
		)
		.refine((projects) => Object.keys(projects).length > 0, "list at least one project"),
});
type Rules = z.infer<typeof Schema>;

const EXAMPLE = `[ci.projects.web]\npaths = ["apps/web", "packages/ui/**"]\nrun = "npm test --workspace web"`;

async function loadRules(root: string): Promise<Rules> {
	const file = join(root, CONFIG_FILE);
	const text = await readFile(file, "utf8").catch(() => undefined);
	let raw: { ci?: unknown } = {};
	try {
		raw = text === undefined ? {} : (parse(text) as { ci?: unknown });
	} catch (error) {
		throw new BasepadError(`${file} isn't valid TOML: ${(error as Error).message}`);
	}
	if (raw.ci === undefined) {
		throw new BasepadError(
			`${file} has no \`[ci]\` rules, so basepad can't tell which projects changed. Add one table per project:\n\n${EXAMPLE}`,
		);
	}
	const parsed = Schema.safeParse(raw.ci);
	if (!parsed.success) {
		throw new BasepadError(`${file}: [ci] is invalid:\n${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
}

/** A path rule: a glob, or a plain path that matches itself and everything under it. */
function matches(pattern: string, file: string): boolean {
	if (/[*?[{]/.test(pattern)) return matchesGlob(file, pattern);
	const path = pattern.replace(/\/+$/, "");
	return file === path || file.startsWith(`${path}/`);
}

interface Base {
	/** The commit the change is measured from, or none when it can't be found. */
	sha?: string;
	/** Where it came from, for the summary line. */
	why: string;
}

const short = (sha: string) => sha.slice(0, 7);

async function resolveCommit(root: string, ref: string): Promise<string | undefined> {
	const out = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		cwd: root,
	});
	return out.code === 0 ? out.stdout.trim() : undefined;
}

/** The base a GitHub Actions event names: the pull request's base, or the push's `before`. */
async function eventBase(): Promise<{ sha: string; why: string } | undefined> {
	const { GITHUB_ACTIONS, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH } = process.env;
	if (GITHUB_ACTIONS !== "true" || !GITHUB_EVENT_PATH) return undefined;
	const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8")) as {
		pull_request?: { base?: { sha?: string } };
		merge_group?: { base_sha?: string };
		before?: string;
	};
	const candidates: [string | undefined, string][] = [
		[event.pull_request?.base?.sha, "the pull request's base"],
		[event.merge_group?.base_sha, "the merge queue's base"],
		// A new branch's first push has no `before`: all zeros.
		[
			GITHUB_EVENT_NAME === "push" && !/^0+$/.test(event.before ?? "") ? event.before : undefined,
			"the push's previous commit",
		],
	];
	for (const [sha, why] of candidates) if (sha) return { sha, why: `${why} ${short(sha)}` };
	return undefined;
}

/** The branch a local run (or a new branch's first push) compares with. */
async function defaultBranch(root: string, rules: Rules): Promise<string | undefined> {
	if (rules.base) return rules.base;
	const head = await exec(
		"git",
		["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
		{
			cwd: root,
		},
	);
	const candidates = [head.code === 0 ? head.stdout.trim() : "", "origin/main", "main", "master"];
	for (const ref of candidates) if (ref && (await resolveCommit(root, ref))) return ref;
	return undefined;
}

async function findBase(root: string, rules: Rules, override?: string): Promise<Base> {
	let ref: string;
	let why: string;
	const event = override === undefined ? await eventBase() : undefined;
	if (override !== undefined) {
		ref = override;
		why = override;
	} else if (event) {
		ref = event.sha;
		why = event.why;
	} else {
		const branch = await defaultBranch(root, rules);
		if (!branch) return { why: "no main branch to compare with" };
		ref = branch;
		why = branch;
	}
	const sha = await resolveCommit(root, ref);
	if (!sha) {
		return {
			why: `${why}, which isn't in this clone (in GitHub Actions, check out with \`fetch-depth: 0\`)`,
		};
	}
	const base = await exec("git", ["merge-base", sha, "HEAD"], { cwd: root });
	if (base.code !== 0) return { why: `${why}, which shares no history with HEAD` };
	return { sha: base.stdout.trim(), why };
}

/** Every path the checkout changed since `base`: commits, uncommitted edits and untracked files. */
async function changedFiles(root: string, base: string): Promise<string[]> {
	const split = (out: string) => out.split("\0").filter(Boolean);
	const diff = await must("git", ["diff", "--name-only", "--no-renames", "-z", base], {
		cwd: root,
	});
	const untracked = await must("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
		cwd: root,
	});
	return [...new Set([...split(diff), ...split(untracked)])];
}

export interface Selection {
	root: string;
	rules: Rules;
	projects: string[];
	/** One line saying what the change was measured against. */
	summary: string;
}

export interface SelectOptions {
	cwd: string;
	/** A ref to compare with, instead of the event's or the default branch. */
	base?: string;
}

/**
 * `basepad changed`: the projects, in the config's order, that the change touches. The change is
 * everything since the merge-base with the base: a pull request's base, a push's previous commit,
 * else the default branch. When the base can't be found, every project is selected.
 */
export async function changed(options: SelectOptions): Promise<Selection> {
	const { root } = await checkout(options.cwd);
	const rules = await loadRules(root);
	const all = Object.keys(rules.projects);
	const base = await findBase(root, rules, options.base);
	if (!base.sha) {
		return { root, rules, projects: all, summary: `Selecting every project: ${base.why}.` };
	}
	const files = await changedFiles(root, base.sha);
	const summary = `${files.length} changed ${files.length === 1 ? "file" : "files"} since ${base.why} (merge-base ${short(base.sha)}).`;
	if (files.some((file) => rules.all.some((pattern) => matches(pattern, file)))) {
		return { root, rules, projects: all, summary: `${summary} A path in \`all\` changed.` };
	}
	const projects = all.filter((name) =>
		rules.projects[name]?.paths.some((pattern) => files.some((file) => matches(pattern, file))),
	);
	return { root, rules, projects, summary };
}

export interface CiOptions extends SelectOptions {
	/** Run these projects, whatever changed. */
	projects: string[];
	/** Run every project. */
	all?: boolean;
}

/**
 * `basepad ci`: runs the selected projects' commands from the repo's root, one project after
 * another. A project stops at its first failing command; the others still run. Resolves to the
 * exit code.
 */
export async function ci(options: CiOptions): Promise<number> {
	let root: string;
	let rules: Rules;
	let projects: string[];
	if (options.all || options.projects.length > 0) {
		root = (await checkout(options.cwd)).root;
		rules = await loadRules(root);
		const known = Object.keys(rules.projects);
		const unknown = options.projects.filter((name) => !known.includes(name));
		if (unknown.length > 0) {
			throw new BasepadError(
				`No project named ${unknown.join(", ")} in [ci.projects]. Projects: ${known.join(", ")}.`,
			);
		}
		projects = options.all ? known : known.filter((name) => options.projects.includes(name));
	} else {
		const selection = await changed(options);
		({ root, rules, projects } = selection);
		console.error(`basepad: ${selection.summary}`);
		if (projects.length === 0) {
			console.error("basepad: No project changed, so there is nothing to run.");
			return 0;
		}
	}

	const results: string[] = [];
	let failed = false;
	for (const name of projects) {
		const run = rules.projects[name]?.run ?? [];
		let failure: string | undefined;
		for (const command of typeof run === "string" ? [run] : run) {
			console.error(`\nbasepad: ${name}: ${command}`);
			const code = await shell(command, root);
			if (code !== 0) {
				failure = `\`${command}\` failed (exit ${code})`;
				break;
			}
		}
		if (failure) failed = true;
		results.push(failure ? `${name}: ${failure}` : `${name}: passed`);
	}
	console.error(`\nbasepad: ${results.join("; ")}.`);
	return failed ? 1 : 0;
}

function shell(command: string, cwd: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "inherit", "inherit"] });
		child.on("error", reject);
		child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
	});
}
