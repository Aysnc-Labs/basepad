import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeWhole } from "../internal/files.ts";
import { aliveAndOurs } from "../internal/processes.ts";
import { checkedOutIn } from "../worktrees.ts";
import type { Removal, Work } from "./model.ts";

export type WorkOrder = { kind: "add" } | Removal;

export type Running = Work & { before?: string[] };

type Record =
	| { kind: "add"; title: string; before?: string[] }
	| {
			kind: "remove";
			title: string;
			namespace: string;
			args: string[];
	  };

interface Shell {
	pid: number;
	start?: string;
}

const STARTING_MS = 30_000;
const LEFT_MS = 60_000;

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
	await writeWhole(`${base}.json`, (partial) => writeFile(partial, JSON.stringify(record)));
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
	await writeWhole(`${base}.pid`, (partial) => writeFile(partial, JSON.stringify(shell)));
}

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
		const code = await exitOf(base);
		if (code === "" && (await underWay(base))) {
			const last = lines(await readFile(`${base}.log`, "utf8").catch(() => "")).at(-1);
			const work: Running =
				record.kind === "add"
					? record
					: { kind: "remove", title: record.title, namespace: record.namespace };
			running.push({ ...work, ...(last === undefined ? {} : { line: last }) });
			continue;
		}
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

function exitOf(base: string): Promise<string> {
	return readFile(`${base}.exit`, "utf8").then(
		(text) => text.trim(),
		() => "",
	);
}

function lines(text: string): string[] {
	return text.split("\n").filter((l) => l.trim() !== "");
}

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
		? aliveAndOurs(shell.pid)
		: start === shell.start;
}

function outcome(record: Record, code: string, output: string[]): string {
	const what =
		record.kind === "add" ? "add a worktree" : `remove ${record.title.slice("Removing ".length)}`;
	const last = output.at(-1) ?? "";
	if (code === "0") return last;
	if (code === "") {
		const said = last === "" ? "" : ` Its last line: ${last}`;
		return `Could not ${what}: it stopped partway${clearing(record, output)}.${said}`;
	}
	const from = output.findLastIndex((l) => l.startsWith("basepad: "));
	const message =
		from === -1
			? [last]
			: [output[from]?.slice("basepad: ".length) ?? "", ...output.slice(from + 1)];
	return `Could not ${what}: ${firstAndLast(message)}`;
}

function clearing(record: Record, output: string[]): string {
	if (record.kind === "remove") return `; run \`basepad ${record.args.join(" ")}\` to finish it`;
	const left = checkedOutIn(output);
	return left === undefined
		? ""
		: `, leaving ${left}; run \`basepad worktree rm ${left}\` to remove it`;
}

function firstAndLast(lines: string[]): string {
	return lines.length <= 2 ? lines.join(" ") : `${lines[0]} … ${lines.at(-1)}`;
}

/**
 * When process `pid` started, as a string to compare; none when it is gone. Linux's
 * `/proc/<pid>/stat` gives it in clock ticks since boot; elsewhere (macOS), `ps`:
 * https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
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
