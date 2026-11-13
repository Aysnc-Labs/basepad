import { readFileSync } from "node:fs";
import { COMMANDS, type Command, type Flag } from "./commands.ts";
import { BasepadError } from "./internal/exec.ts";

/** Flags every command takes. */
const HELP: Record<string, Flag> = { help: { short: "h", description: "Show this help" } };
/** Flags `basepad` takes before a command. */
const TOP_FLAGS: Record<string, Flag> = {
	...HELP,
	version: { short: "v", description: "Show basepad's version" },
};

async function main(argv: string[]): Promise<number> {
	const [first, ...rest] = argv;
	if (first === undefined) {
		process.stdout.write(topHelp());
		return 1;
	}
	if (first.startsWith("-")) {
		const flags = parseFlags([first, ...rest], TOP_FLAGS, "basepad");
		if (flags.version) {
			process.stdout.write(`${version()}\n`);
			return 0;
		}
		process.stdout.write(topHelp());
		return 0;
	}
	// A command is one word, or two for a group's (`worktree add`).
	const pair = rest[0] === undefined ? undefined : `${first} ${rest[0]}`;
	const name = pair !== undefined && pair in COMMANDS ? pair : first;
	const command = COMMANDS[name];
	if (!command) {
		const group = Object.keys(COMMANDS).some((key) => key.startsWith(`${first} `));
		const typed = group ? (pair ?? first) : first;
		throw new BasepadError(
			`Unknown command \`${typed}\`. The nearest is \`${nearest(typed, Object.keys(COMMANDS))}\`; run \`basepad --help\` for every command.`,
		);
	}
	const args = name === pair ? rest.slice(1) : rest;
	const flags = parseFlags(args, { ...command.flags, ...HELP }, `basepad ${name}`);
	if (flags.help) {
		process.stdout.write(commandHelp(name, command));
		return 0;
	}
	await command.run({ cwd: process.cwd(), flags, print: (line) => console.log(line) });
	return 0;
}

/**
 * Reads flags by long or short name: a switch, or a flag with a value, which takes the next
 * argument. Anything else is an error naming the nearest flag.
 */
function parseFlags(
	args: string[],
	known: Record<string, Flag>,
	usage: string,
): Record<string, boolean | string> {
	const flags: Record<string, boolean | string> = {};
	const spellings = Object.entries(known).flatMap(([name, flag]) => [
		[`--${name}`, name],
		...(flag.short ? [[`-${flag.short}`, name]] : []),
	]) as [string, string][];
	const byArg = new Map(spellings);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const name = byArg.get(arg);
		const value = name === undefined ? undefined : known[name]?.value;
		if (name !== undefined && value === undefined) {
			flags[name] = true;
			continue;
		}
		if (name !== undefined) {
			const given = args[++i];
			if (given === undefined || given.startsWith("-")) {
				throw new BasepadError(`\`${arg}\` needs a ${value}: \`${usage} ${arg} <${value}>\`.`);
			}
			flags[name] = given;
			continue;
		}
		if (!arg.startsWith("-"))
			throw new BasepadError(`\`${usage}\` takes no arguments; got \`${arg}\`.`);
		const near = nearest(
			arg,
			Object.keys(known).map((n) => `--${n}`),
		);
		throw new BasepadError(
			`\`${usage}\` has no flag \`${arg}\`. The nearest is \`${near}\`; run \`${usage} --help\` for its flags.`,
		);
	}
	return flags;
}

/** The candidate with the fewest edits from `word`. */
function nearest(word: string, candidates: string[]): string {
	let best = candidates[0] ?? "";
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const d = distance(word, candidate);
		if (d < bestDistance) [best, bestDistance] = [candidate, d];
	}
	return best;
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + cost);
		}
		row = next;
	}
	return row[b.length] ?? 0;
}

function topHelp(): string {
	return [
		"Usage: basepad <command> [flags]",
		"",
		"Commands:",
		...columns(Object.entries(COMMANDS).map(([name, command]) => [name, command.summary])),
		"",
		"Flags:",
		...flagLines(TOP_FLAGS),
		"",
		"Run `basepad <command> --help` for a command's flags.",
		"",
	].join("\n");
}

function commandHelp(name: string, command: Command): string {
	return [
		`Usage: basepad ${name} [flags]`,
		"",
		`${command.summary}.`,
		"",
		"Flags:",
		...flagLines({ ...command.flags, ...HELP }),
		"",
	].join("\n");
}

function flagLines(flags: Record<string, Flag>): string[] {
	return columns(
		Object.entries(flags).map(([name, flag]) => [
			`${flag.short ? `-${flag.short}, --${name}` : `    --${name}`}${flag.value ? ` <${flag.value}>` : ""}`,
			flag.description,
		]),
	);
}

function columns(rows: [string, string][]): string[] {
	const width = Math.max(...rows.map(([left]) => left.length));
	return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function version(): string {
	const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
	return (JSON.parse(pkg) as { version: string }).version;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof BasepadError ? `basepad: ${error.message}` : error);
		process.exitCode = 1;
	},
);
