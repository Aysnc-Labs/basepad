import { readFile } from "node:fs/promises";
import { shellQuote } from "./exec.ts";

/**
 * Whether process `pid` is there, whoever runs it: a server basepad runs as its service user
 * cannot be signalled, and is there all the same.
 */
export function alive(pid: number): boolean {
	return signalled(pid) !== "gone";
}

/** Whether process `pid` is there and ours: one we may not signal is another user's. */
export function aliveAndOurs(pid: number): boolean {
	return signalled(pid) === "ours";
}

function signalled(pid: number): "ours" | "another's" | "gone" {
	try {
		process.kill(pid, 0);
		return "ours";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? "another's" : "gone";
	}
}

/**
 * A shell command writing the shell's process id and `port` to `file`, a line each, for a daemon's
 * `run` that then `exec`s its server: `exec` keeps the shell's process id, so the file names the
 * running server. `runningPort(file)` reads it back.
 */
export function recordRunning(file: string, port: number): string {
	return `printf '%s\\n%s\\n' "$$" ${port} > ${shellQuote(file)}`;
}

/**
 * The port in pid file `file` while its process runs: the process id is its first line, the port
 * its line `portLine` (from 0). None when the file or either line is missing, or the process is gone.
 */
export async function runningPort(file: string, portLine = 1): Promise<number | undefined> {
	const lines = (await readFile(file, "utf8").catch(() => "")).split("\n");
	const pid = Number(lines[0]);
	const port = Number(lines[portLine]);
	if (!pid || !port || !alive(pid)) return undefined;
	return port;
}
