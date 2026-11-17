import { readFile } from "node:fs/promises";
import { shellQuote } from "./exec.ts";

export function alive(pid: number): boolean {
	return signalled(pid) !== "gone";
}

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

export function recordRunning(file: string, port: number): string {
	return `printf '%s\\n%s\\n' "$$" ${port} > ${shellQuote(file)}`;
}

export async function runningPort(file: string, portLine = 1): Promise<number | undefined> {
	const lines = (await readFile(file, "utf8").catch(() => "")).split("\n");
	const pid = Number(lines[0]);
	const port = Number(lines[portLine]);
	if (!pid || !port || !alive(pid)) return undefined;
	return port;
}
