import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BasepadError, exec, must } from "./internal/exec.ts";

const TOOL_ONLY_NO_SKILLS = { MISE_SKILLS_FETCH: "false" };

export interface Tool {
	dir: string;
	bin(program: string): string;
}

/** Installs a tool basepad itself runs, in basepad's home, outside any project's mise config. */
export async function install(tool: string, version: string, basepadHome: string): Promise<Tool> {
	const spec = `${tool}@${version}`;
	await mkdir(basepadHome, { recursive: true });
	await must("mise", ["install", "--quiet", spec], {
		cwd: basepadHome,
		env: { ...process.env, ...TOOL_ONLY_NO_SKILLS },
	});
	const dir = (await must("mise", ["where", spec], { cwd: basepadHome })).trim();
	const paths = (await must("mise", ["bin-paths", spec], { cwd: basepadHome }))
		.split("\n")
		.filter(Boolean);
	return {
		dir,
		bin(program) {
			for (const path of paths) {
				const file = join(path, program);
				if (existsSync(file)) return file;
			}
			throw new BasepadError(`mise's ${spec} has no \`${program}\` in ${paths.join(", ")}.`);
		},
	};
}

/** A tool line of a mise config, as `up` suggests it when a program is missing. */
export interface MiseTool {
	name: string;
	version: string;
	/** The `[tool_alias]` that `name` stands for, when it is no tool of mise's registry. */
	alias?: string;
}

const readied = new Map<string, Promise<void>>();
const found = new Map<string, Promise<string | undefined>>();

/**
 * Finds programs the way the shell does in `checkout`: the mise config there must be trusted, its
 * tools are installed, and each program is `mise which <program>`. `needed` maps each program to
 * the tool that gives it by default, which a missing program's error asks the user to add.
 */
export async function programsIn<P extends string>(
	checkout: string,
	needed: Record<P, MiseTool>,
): Promise<Record<P, string>> {
	await once(readied, checkout, () => readyTools(checkout));
	const programs = Object.keys(needed) as P[];
	const paths = await Promise.all(
		programs.map((program) =>
			once(found, `${checkout}\0${program}`, () => which(checkout, program)),
		),
	);
	const missing = programs.filter((_, i) => paths[i] === undefined);
	if (missing.length > 0) throw new BasepadError(missingPrograms(checkout, missing, needed));
	return Object.fromEntries(programs.map((program, i) => [program, paths[i]])) as Record<P, string>;
}

function once<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const made = make();
	cache.set(key, made);
	made.catch(() => cache.delete(key));
	return made;
}

const MISE_NOISE = /^mise ERROR (Version:|Run with --verbose)/;

async function readyTools(checkout: string): Promise<void> {
	const read = await exec("mise", ["ls", "--current"], { cwd: checkout });
	if (read.code !== 0) {
		const error = read.stderr
			.split("\n")
			.filter((line) => line !== "" && !MISE_NOISE.test(line))
			.join("\n");
		const untrusted = error.match(/Config files in (.+) are not trusted\./)?.[1];
		if (untrusted === undefined) {
			throw new BasepadError(`mise can't read the mise config at ${checkout}:\n${error}`);
		}
		throw new BasepadError(
			`mise doesn't trust the mise config at ${checkout}, and basepad never trusts one for you:\n${error}\nTrust it with \`mise trust ${untrusted}\`, or trust every project in a folder with \`trusted_config_paths\` in your global mise config (~/.config/mise/config.toml).`,
		);
	}
	await must("mise", ["install", "--quiet"], {
		cwd: checkout,
		env: { ...process.env, ...TOOL_ONLY_NO_SKILLS },
	});
}

async function which(checkout: string, program: string): Promise<string | undefined> {
	const out = await exec("mise", ["which", program], { cwd: checkout });
	return out.code === 0 ? out.stdout.trim() : undefined;
}

function missingPrograms<P extends string>(
	checkout: string,
	missing: P[],
	needed: Record<P, MiseTool>,
): string {
	const tools = [...new Map(missing.map((program) => [needed[program].name, needed[program]]))];
	const aliases = tools.flatMap(([name, tool]) =>
		tool.alias === undefined ? [] : [`${name} = "${tool.alias}"`],
	);
	const lines = [
		...(aliases.length > 0 ? ["[tool_alias]", ...aliases, ""] : []),
		"[tools]",
		...tools.map(([name, tool]) => `${name} = "${tool.version}"`),
	];
	const programs = missing.map((program) => `\`${program}\``).join(", ");
	return `No tool in the mise config at ${checkout} gives ${programs}. Add these lines to ${join(checkout, "mise.toml")}:\n\n${lines.join("\n")}`;
}
