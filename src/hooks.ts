import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Project } from "./config.ts";
import { valuesOf } from "./env-files.ts";
import { BasepadError } from "./internal/exec.ts";
import { throughMise } from "./internal/mise.ts";
import { trustedIn } from "./tools.ts";

export const HOOK_EVENTS = [
	"Create",
	"Up",
	"Down",
	"Remove",
	"Save",
	"Load",
	"Import",
	"Export",
	"Delete",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookName = `before${HookEvent}` | `after${HookEvent}`;

export const HOOK_NAMES: HookName[] = HOOK_EVENTS.flatMap((event) => [
	`before${event}` as const,
	`after${event}` as const,
]);

export interface HookRun {
	environment: string | undefined;
	say(line: string): void;
	keysFrom?: string;
	variables?: Record<string, string>;
	warnOnly?: true;
}

export type RunHook = (name: HookName) => Promise<void>;

export function hooksOf(project: Project, run: HookRun): RunHook {
	return async (name) => {
		const commands = project.hooks[name] ?? [];
		if (commands.length === 0) return;
		try {
			await trustedIn(project.root);
		} catch (error) {
			if (run.warnOnly !== true || !(error instanceof BasepadError)) throw error;
			console.error(`basepad: ${error.message}\nSkipping ${name}.`);
			return;
		}
		const env = {
			...(await envFileKeys(project, run.keysFrom ?? project.root)),
			...run.variables,
			BASEPAD_EVENT: name,
			BASEPAD_ENVIRONMENT: run.environment ?? "main",
		};
		const failed = await runCommands(project.root, commands, env, (command) => {
			run.say(`Running ${name} \`${command}\``);
			return (line) => run.say(`  ${line}`);
		});
		if (failed === undefined) return;
		const message = `${name} \`${failed.command}\` failed (exit ${failed.code}).`;
		if (run.warnOnly !== true) throw new BasepadError(message);
		console.error(`basepad: ${message} Going on.`);
	};
}

async function runCommands(
	dir: string,
	commands: string[],
	variables: Record<string, string>,
	starting: (command: string) => (line: string) => void,
): Promise<{ command: string; code: number } | undefined> {
	const env: NodeJS.ProcessEnv = { ...process.env, ...variables };
	if (env.BASEPAD_PATH) env.PATH = env.BASEPAD_PATH;
	delete env.BASEPAD_PATH;
	const names = Object.keys(variables);
	for (const command of commands) {
		const code = await streamed(dir, throughMise(command, names), env, starting(command));
		if (code !== 0) return { command, code };
	}
	return undefined;
}

function streamed(
	dir: string,
	script: string,
	env: NodeJS.ProcessEnv,
	line: (text: string) => void,
): Promise<number> {
	return new Promise((done, fail) => {
		const child = spawn("sh", ["-c", script], {
			cwd: dir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (const stream of [child.stdout, child.stderr]) {
			createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on("line", line);
		}
		child.on("error", fail);
		child.on("close", (code) => done(code ?? 1));
	});
}

async function envFileKeys(project: Project, root: string): Promise<Record<string, string>> {
	const keys: Record<string, string> = {};
	for (const { path, names } of envFileShape(project)) {
		const text = await readFile(resolve(root, path), "utf8").catch(() => undefined);
		if (text !== undefined) Object.assign(keys, valuesOf(text, names));
	}
	return keys;
}

interface EnvFileShape {
	path: string;
	names: string[];
}

const shapes = new WeakMap<Project, EnvFileShape[]>();

function envFileShape(project: Project): EnvFileShape[] {
	const known = shapes.get(project);
	if (known !== undefined) return known;
	const shape = shapeOf(project);
	shapes.set(project, shape);
	return shape;
}

function shapeOf(project: Project): EnvFileShape[] {
	let files: unknown;
	try {
		files = project.env(anyOutputs as Parameters<Project["env"]>[0]);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`basepad: hooks get no env file keys: \`env\` threw on basepad's placeholder outputs: ${reason}`,
		);
		return [];
	}
	if (typeof files !== "object" || files === null) return [];
	return Object.entries(files).flatMap(([path, keys]) =>
		typeof keys === "object" && keys !== null ? [{ path, names: Object.keys(keys) }] : [],
	);
}

const PLACEHOLDER = "http://basepad.invalid/";
const anyValue: unknown = new Proxy(
	{},
	{ get: (_, key) => (key === Symbol.toPrimitive ? () => PLACEHOLDER : PLACEHOLDER) },
);
const anyOutputs: unknown = new Proxy({}, { get: () => anyValue });
