import { spawn } from "node:child_process";

export interface Output {
	code: number;
	stdout: string;
	stderr: string;
}

/** A failure the user can act on. The CLI prints its message without a stack. */
export class BasepadError extends Error {}

export interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Written to the program's stdin, which is otherwise closed. */
	input?: string;
}

/** Runs a program to completion and captures its output. Never throws for a non-zero exit. */
export function exec(
	file: string,
	args: readonly string[],
	options: ExecOptions = {},
): Promise<Output> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		child.stdin?.end(options.input);
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") reject(new BasepadError(`basepad needs \`${file}\` on PATH.`));
			else reject(error);
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

/** Runs a program and returns its stdout, or throws with what it printed. */
export async function must(
	file: string,
	args: readonly string[],
	options: ExecOptions = {},
): Promise<string> {
	const out = await exec(file, args, options);
	if (out.code !== 0) {
		const detail = (out.stderr || out.stdout).trim();
		throw new BasepadError(
			`\`${[file, ...args].join(" ")}\` failed (exit ${out.code}):\n${detail}`,
		);
	}
	return out.stdout;
}

/** Quotes one word for a POSIX shell. */
export function shellQuote(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
