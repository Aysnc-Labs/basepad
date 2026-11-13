/**
 * Env files: basepad sets exactly the keys the config names, and nothing else in the file changes.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EnvFiles } from "./index.ts";

/**
 * Sets each file's keys, paths resolved from `root`, creating a file that is missing. A file whose
 * keys already read as wanted is not written. Returns the paths it changed.
 */
export async function writeEnvFiles(root: string, files: EnvFiles): Promise<string[]> {
	const changed: string[] = [];
	for (const [path, keys] of Object.entries(files)) {
		const file = resolve(root, path);
		const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		const next = setKeys(text ?? "", keys);
		if (next === text) continue;
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, next);
		changed.push(path);
	}
	return changed;
}

/** One `KEY=value` assignment's start: optional `export`, the key, then `=`. */
const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)/;

/**
 * Sets `keys` in an env file's text: in place where a key is assigned (every assignment of it),
 * appended in the order given where it is not. Every other byte is kept. A key whose value already
 * reads as the wanted one is left as written, so setting the same keys twice changes nothing.
 */
export function setKeys(text: string, keys: Record<string, string | number>): string {
	const wanted = new Map(Object.entries(keys).map(([key, value]) => [key, String(value)]));
	const found = new Set<string>();
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const match = ASSIGNMENT.exec(line);
		const key = match?.[2];
		if (!match || key === undefined || !wanted.has(key)) {
			out.push(line);
			continue;
		}
		found.add(key);
		// A quoted value may run over several lines; take them all as this assignment.
		let assignment = line;
		while (opensQuote(assignment.slice(match[0].length)) && i + 1 < lines.length) {
			i++;
			assignment += lines[i];
		}
		const ending = /\r?\n$/.exec(assignment)?.[0] ?? "";
		const raw = assignment.slice(match[0].length, assignment.length - ending.length);
		const value = wanted.get(key) as string;
		out.push(
			readValue(raw) === value
				? assignment
				: `${match[1]}${key}${match[3]}${quote(value)}${ending}`,
		);
	}
	const missing = [...wanted].filter(([key]) => !found.has(key));
	if (missing.length === 0) return out.join("");
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const gap = text === "" || text.endsWith("\n") ? "" : newline;
	return `${out.join("")}${gap}${missing.map(([key, value]) => `${key}=${quote(value)}${newline}`).join("")}`;
}

/** Whether a raw value starts a quoted string it does not close. */
function opensQuote(raw: string): boolean {
	const q = raw[0];
	if (q !== '"' && q !== "'") return false;
	return closing(raw, q) === -1;
}

/** The index of the quote closing a value that starts with `q`, or -1. */
function closing(raw: string, q: string): number {
	for (let i = 1; i < raw.length; i++) {
		if (q === '"' && raw[i] === "\\") i++;
		else if (raw[i] === q) return i;
	}
	return -1;
}

/** What a raw value reads as: quoted literally or with escapes, or bare up to a ` #` comment. */
function readValue(raw: string): string {
	const q = raw[0];
	if (q === "'" || q === '"') {
		const end = closing(raw, q);
		if (end === -1) return raw;
		const inner = raw.slice(1, end);
		return q === "'" ? inner : inner.replace(/\\(.)/gs, (_, c: string) => (c === "n" ? "\n" : c));
	}
	return raw.replace(/\s+#.*$/, "").trim();
}

/**
 * A value as written: bare when that reads back the same in every common parser, else in single
 * quotes (literal, no expansion), else in double quotes with `\` and `"` escaped.
 */
export function quote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./?&~-]*$/.test(value)) return value;
	if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}
