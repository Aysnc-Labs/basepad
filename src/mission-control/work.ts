import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkedOutIn } from "../worktrees.ts";
import type { Removal, Work } from "./model.ts";

/**
 * A worktree's addition or removal from mission control, run as `basepad worktree add` or
 * `worktree rm` itself in a process of its own, which outlives the view: closing the view, or a
 * crash in it, stops nothing. Each one leaves files in `dir` (Layout's `workHome`): a record, its
 * shell's pid, its output, and once done, its exit code. So a view opened later shows it too.
 */

/** What to run: an addition, or a worktree's removal. */
export type WorkOrder = { kind: "add" } | Removal;

/** Work under way as read from its files; an addition with the worktrees there before it began. */
export type Running = Work & { before?: string[] };

/** A record of work started, in `<id>.json`. */
interface Record {
	kind: Work["kind"];
	title: string;
	namespace?: string;
	before?: string[];
	/** A removal's `basepad worktree rm` arguments, so one stopped partway can say how to finish. */
	args?: string[];
}

/**
 * The shell that runs the command and writes its exit code, in `<id>.pid` once it has started:
 * its pid, and when it started as the system says (`startOf`), since a pid alone may be reused.
 */
interface Shell {
	pid: number;
	start?: string;
}

/** How long a record waits for its command to start before it is given up as never started. */
const STARTING_MS = 30_000;
/** How old a file left without a record (a view gone partway) is when it is swept. */
const LEFT_MS = 60_000;

/**
 * Starts `command` (the `basepad` command, as argv) with `worktree add` or `worktree rm`, in `cwd`,
 * in a process group of its own that the view's Ctrl-C does not reach. Resolves once it runs.
 * `before`, for an addition: the worktrees there now, so a new one is known until it is ready.
 */
export async function startWork(options: {
	dir: string;
	command: string[];
	cwd: string;
	order: WorkOrder;
	before?: string[];
}): Promise<void> {
	const { dir, command, cwd, order, before } = options;
	await mkdir(dir, { recursive: true });
	const base = join(dir, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	const args =
		order.kind === "add"
			? ["worktree", "add"]
			: ["worktree", "rm", order.suffix, ...(order.force ? ["--force"] : [])];
	const record: Record =
		order.kind === "add"
			? { kind: "add", title: "Adding a worktree", ...(before ? { before } : {}) }
			: { kind: "remove", title: `Removing ${order.suffix}`, namespace: order.namespace, args };
	// The record first, and never written again: a fast job taken meanwhile is not made again.
	await writeFile(`${base}.json`, JSON.stringify(record));
	// The shell outlives the view with the command, and writes the exit code once it ends.
	const child = spawn(
		"sh",
		["-c", '"$@" >"$0.log" 2>&1; echo $? >"$0.exit"', base, ...command, ...args],
		{ cwd, detached: true, stdio: "ignore" },
	);
	child.unref();
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	}).catch(async (error: unknown) => {
		await rm(`${base}.json`, { force: true });
		throw error;
	});
	const pid = child.pid as number;
	const start = await startOf(pid);
	const shell: Shell = { pid, ...(start === undefined ? {} : { start }) };
	await writeFile(`${base}.pid`, JSON.stringify(shell));
}

/**
 * The work in `dir`: what runs, oldest first, with the last line each printed; and what has
 * finished, as what to tell the developer. Each finished one is told once: its files go as it is read.
 * Files a view left without a record are swept untold once a minute old.
 */
export async function takeWork(dir: string): Promise<{ running: Running[]; finished: string[] }> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const running: Running[] = [];
	const finished: string[] = [];
	const records = new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)));
	for (const name of names) {
		const id = name.slice(0, name.lastIndexOf("."));
		if (records.has(id)) continue;
		const file = join(dir, name);
		const old = await stat(file).then(
			(s) => Date.now() - s.mtimeMs > LEFT_MS,
			() => false,
		);
		if (old) await rm(file, { force: true });
	}
	for (const name of [...records].sort().map((id) => `${id}.json`)) {
		const base = join(dir, name.slice(0, -".json".length));
		const record = await readFile(`${base}.json`, "utf8").then(
			(text) => JSON.parse(text) as Record,
			() => undefined,
		);
		if (record === undefined) continue;
		// The exit code before the output: once it is written, the output is whole.
		const code = await exitOf(base);
		if (code === "" && (await underWay(base))) {
			const last = lines(await readFile(`${base}.log`, "utf8").catch(() => "")).at(-1);
			const { args: _, ...work } = record;
			running.push({ ...work, ...(last === undefined ? {} : { line: last }) });
			continue;
		}
		// Taken by renaming its record: of views reading at once, only the one that renames it tells it.
		const taken = await rename(`${base}.json`, `${base}.taken`).then(
			() => true,
			() => false,
		);
		if (!taken) continue;
		const output = lines(await readFile(`${base}.log`, "utf8").catch(() => ""));
		const ended = await exitOf(base);
		finished.push(outcome(record, ended, output));
		await Promise.all(
			[".taken", ".log", ".exit", ".pid"].map((ext) => rm(`${base}${ext}`, { force: true })),
		);
	}
	return { running, finished };
}

/** A job's exit code; empty while it runs, or when it was killed. */
function exitOf(base: string): Promise<string> {
	return readFile(`${base}.exit`, "utf8").then(
		(text) => text.trim(),
		() => "",
	);
}

function lines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim() !== "");
}

/**
 * Whether a record's command still runs: its shell is there and started when `.pid` says, so a pid
 * reused by another process is not taken for it; where its start cannot be read, its pid is there.
 * A record whose command has not started yet is under way for a short while, then given up.
 */
async function underWay(base: string): Promise<boolean> {
	const shell = await readFile(`${base}.pid`, "utf8").then(
		(text) => JSON.parse(text) as Shell,
		() => undefined,
	);
	if (shell === undefined) {
		const written = await stat(`${base}.json`).then(
			(s) => s.mtimeMs,
			() => 0,
		);
		return Date.now() - written < STARTING_MS;
	}
	const start = await startOf(shell.pid);
	return start === undefined || shell.start === undefined
		? alive(shell.pid)
		: start === shell.start;
}

/** Whether a process of ours is there: one we may not signal is not ours. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * How finished work ended, from its exit code (none when killed) and its output. One stopped
 * partway says how to clear what it left: a removal's own command, or the worktree an addition's
 * output says it checked out. With no such line, it made none, or none it can name.
 */
function outcome(record: Record, code: string, output: string[]): string {
	const what =
		record.kind === "add" ? "add a worktree" : `remove ${record.title.slice("Removing ".length)}`;
	const last = output.at(-1) ?? "";
	if (code === "0") return last;
	if (code === "") {
		const left = record.kind === "add" ? checkedOutIn(output) : undefined;
		const next =
			left !== undefined
				? `, leaving ${left}; run \`basepad worktree rm ${left}\` to remove it`
				: record.args !== undefined
					? `; run \`basepad ${record.args.join(" ")}\` to finish it`
					: "";
		return `Could not ${what}: it stopped partway${next}. Its last line: ${last}`;
	}
	// The command says why it failed last, after `basepad: `.
	const from = output.findLastIndex((l) => l.startsWith("basepad: "));
	const message =
		from === -1
			? [last]
			: [output[from]?.slice("basepad: ".length) ?? "", ...output.slice(from + 1)];
	return `Could not ${what}: ${firstAndLast(message)}`;
}

/** Lines of a message as one: its first and last, which say what failed and what next. */
function firstAndLast(lines: string[]): string {
	return lines.length <= 2 ? lines.join(" ") : `${lines[0]} … ${lines.at(-1)}`;
}

/**
 * When process `pid` started, as a string to compare; none when it is gone. Linux's
 * `/proc/<pid>/stat` gives it in clock ticks since boot; elsewhere (macOS), `ps`.
 */
async function startOf(pid: number): Promise<string | undefined> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
	if (stat !== undefined) {
		// The fields after the command's name, which is in parentheses and may hold spaces.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	}
	if (process.platform === "linux") return undefined;
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
			const start = stdout.trim();
			resolve(error || start === "" ? undefined : start);
		});
	});
}
