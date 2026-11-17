import { spawn } from "node:child_process";

export interface Output {
	code: number;
	stdout: string;
	stderr: string;
}

export class BasepadError extends Error {}

export interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	input?: string;
}

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

export async function must(
	file: string,
	args: readonly string[],
	options: ExecOptions & { label?: string } = {},
): Promise<string> {
	const out = await exec(file, args, options);
	if (out.code !== 0) {
		const detail = (out.stderr || out.stdout).trim();
		const label = options.label ?? [file, ...args].join(" ");
		throw new BasepadError(`\`${label}\` failed (exit ${out.code}):\n${detail}`);
	}
	return out.stdout;
}

export function shellQuote(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function interactive(
	file: string,
	args: readonly string[],
	options: ExecOptions = {},
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}
