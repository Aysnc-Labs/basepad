import { z } from "zod";
import { BasepadError, exec, must } from "./exec.ts";

/** One entry of `mise daemons ls --json`. Only the fields basepad reads; the rest pass through. */
const Daemon = z.looseObject({
	id: z.string(),
	name: z.string(),
	root: z.string(),
	status: z.string(),
	pid: z.number().nullable().optional(),
	port: z.number().nullable().optional(),
	url: z.string().nullable().optional(),
});
export type Daemon = z.infer<typeof Daemon>;

export function mise(cwd: string, ...args: string[]): Promise<string> {
	return must("mise", args, { cwd });
}

/** The daemons visible from `cwd`, or `undefined` when its config isn't trusted. */
export async function daemons(cwd: string): Promise<Daemon[] | undefined> {
	const out = await exec("mise", ["daemons", "ls", "--json"], { cwd });
	if (out.code !== 0) {
		if (/not trusted/.test(out.stderr)) return undefined;
		throw new BasepadError(`\`mise daemons ls\` failed in ${cwd}:\n${out.stderr.trim()}`);
	}
	return z.array(Daemon).parse(JSON.parse(out.stdout));
}
