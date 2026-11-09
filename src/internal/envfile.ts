import { readFile, writeFile } from "node:fs/promises";

const START = "# >>> basepad";
const END = "# <<< basepad";

/**
 * Writes `vars` into basepad's marked block of an env file, creating the file or the block as
 * needed. Every byte outside the block is kept as it was.
 */
export async function writeEnvBlock(file: string, vars: Record<string, string>): Promise<void> {
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const block = [
		`${START} (written by basepad; edits inside this block are overwritten)`,
		...Object.entries(vars).map(([key, value]) => `${key}=${value}`),
		END,
	].join("\n");

	const start = findLine(text, START);
	const end = start === -1 ? -1 : findLine(text, END, start);
	let next: string;
	if (start !== -1 && end !== -1) {
		next = text.slice(0, start) + block + text.slice(end + END.length);
	} else {
		const separator = text === "" || text.endsWith("\n") ? "" : "\n";
		next = `${text}${separator}${text === "" ? "" : "\n"}${block}\n`;
	}
	if (next !== text) await writeFile(file, next);
}

/** The offset of the first line starting with `marker`, at or after `from`, or -1. */
function findLine(text: string, marker: string, from = 0): number {
	let at = text.indexOf(marker, from);
	while (at !== -1 && at !== 0 && text[at - 1] !== "\n") at = text.indexOf(marker, at + 1);
	return at;
}

/** The variables in an env file's basepad block, or none when it has no block. */
export async function readEnvBlock(file: string): Promise<Record<string, string>> {
	const text = await readFile(file, "utf8").catch(() => "");
	const start = findLine(text, START);
	const end = start === -1 ? -1 : findLine(text, END, start);
	if (end === -1) return {};
	const vars: Record<string, string> = {};
	for (const line of text.slice(text.indexOf("\n", start) + 1, end).split("\n")) {
		const at = line.indexOf("=");
		if (at > 0 && !line.startsWith("#")) vars[line.slice(0, at)] = line.slice(at + 1);
	}
	return vars;
}

/** Takes basepad's block out of an env file, with the blank line before it, keeping the rest. */
export async function removeEnvBlock(file: string): Promise<void> {
	const text = await readFile(file, "utf8").catch(() => undefined);
	if (text === undefined) return;
	const start = findLine(text, START);
	const end = start === -1 ? -1 : findLine(text, END, start);
	if (end === -1) return;
	const before = text.slice(0, start).replace(/\n\n$/, "\n");
	const after = text.slice(end + END.length).replace(/^\n/, "");
	await writeFile(file, before + after);
}
