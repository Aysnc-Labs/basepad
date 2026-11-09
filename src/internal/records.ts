import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * What basepad made on this machine for one of a project's services. The project's config says
 * which services it has; these records say where they are.
 */
const Service = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("postgres"),
		/** Each of the service's databases, by its name in the config, to its name in Postgres. */
		databases: z.record(z.string(), z.string()),
	}),
	z.object({ type: z.literal("mailpit") }),
	z.object({ type: z.literal("redis"), port: z.number() }),
]);
export type Service = z.infer<typeof Service>;

const Project = z.object({
	services: z.record(z.string(), Service),
	/** The app server's port, for the variables that point at the app. */
	app: z.object({ port: z.number() }).optional(),
});
export type Project = z.infer<typeof Project>;

/** A shared daemon in the home project: its mise table, and the tools it runs. */
const Daemon = z.object({ tools: z.record(z.string(), z.string()), table: z.string() });
export type Daemon = z.infer<typeof Daemon>;

/** basepad's own records, kept in the home project. They hold the shared server's password. */
const Records = z.object({
	version: z.literal(1),
	postgres: z.object({ port: z.number(), password: z.string() }).optional(),
	mailpit: z.object({ smtpPort: z.number(), uiPort: z.number() }).optional(),
	daemons: z.record(z.string(), Daemon).default({}),
	projects: z.record(z.string(), Project),
});
export type Records = z.infer<typeof Records>;

export async function loadRecords(file: string): Promise<Records> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { version: 1, daemons: {}, projects: {} };
		throw error;
	}
	return Records.parse(JSON.parse(text));
}

/** Writes atomically, readable by the owner only. */
export async function saveRecords(file: string, records: Records): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
	await chmod(temp, 0o600);
	await rename(temp, file);
}
