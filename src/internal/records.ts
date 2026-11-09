import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** A service a project added, and what basepad made for it. */
const Service = z.object({
	type: z.literal("postgres"),
	database: z.string(),
});
export type Service = z.infer<typeof Service>;

const Project = z.object({
	preset: z.enum(["next"]),
	services: z.record(z.string(), Service),
});
export type Project = z.infer<typeof Project>;

/** basepad's own records, kept in the home project. They hold the shared server's password. */
const Records = z.object({
	version: z.literal(1),
	postgres: z.object({ port: z.number(), password: z.string() }).optional(),
	projects: z.record(z.string(), Project),
});
export type Records = z.infer<typeof Records>;

export async function loadRecords(file: string): Promise<Records> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
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
