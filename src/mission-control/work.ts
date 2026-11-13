import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Removal, Work } from "./model.ts";

/**
 * A worktree's addition or removal from mission control, run as `basepad worktree add` or
 * `worktree rm` itself in a process of its own, which outlives the view: closing the view, or a
 * crash in it, stops nothing. Each one leaves files in `dir` (Layout's `workHome`): a record, its
 * output, and once done, its exit code. So a view opened later shows it too.
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
	/** The shell that runs the command and writes its exit code. */
	pid: number;
}

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
	});
	const record: Record =
		order.kind === "add"
			? {
					kind: "add",
					title: "Adding a worktree",
					...(before ? { before } : {}),
					pid: child.pid ?? 0,
				}
			: {
					kind: "remove",
					title: `Removing ${order.suffix}`,
					namespace: order.namespace,
					pid: child.pid ?? 0,
				};
	await writeFile(`${base}.json`, JSON.stringify(record));
}

/**
 * The work in `dir`: what runs, oldest first, with the last line each printed; and what has
 * finished, as what to tell the developer. Each finished one is told once: its files go as it is read.
 */
export async function takeWork(dir: string): Promise<{ running: Running[]; finished: string[] }> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const running: Running[] = [];
	const finished: string[] = [];
	for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
		const base = join(dir, name.slice(0, -".json".length));
		const record = await readFile(`${base}.json`, "utf8").then(
			(text) => JSON.parse(text) as Record,
			() => undefined,
		);
		if (record === undefined) continue;
		const output = (await readFile(`${base}.log`, "utf8").catch(() => ""))
			.split("\n")
			.filter((l) => l.trim() !== "");
		const code = (await readFile(`${base}.exit`, "utf8").catch(() => "")).trim();
		const { pid, ...work } = record;
		if (code === "" && alive(pid)) {
			const last = output.at(-1);
			running.push({ ...work, ...(last === undefined ? {} : { line: last }) });
			continue;
		}
		finished.push(outcome(record, code, output));
		await Promise.all(
			[".json", ".log", ".exit"].map((ext) => rm(`${base}${ext}`, { force: true })),
		);
	}
	return { running, finished };
}

/** How finished work ended, from its exit code (none when killed) and its output. */
function outcome(record: Record, code: string, output: string[]): string {
	const what =
		record.kind === "add" ? "add a worktree" : `remove ${record.title.slice("Removing ".length)}`;
	const last = output.at(-1) ?? "";
	if (code === "0") return last;
	if (code === "") return `Could not ${what}: it stopped partway. Its last line: ${last}`;
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

/** Whether a process is still there. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
