import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BasepadError } from "./exec.ts";
import { mise } from "./mise.ts";
import { loadRecords, type Records, saveRecords } from "./records.ts";
import { MISE_MIN_VERSION, PITCHFORK_VERSION, POSTGRES_VERSION } from "./versions.ts";

/** The daemon namespace of the home project, so shared daemons have stable IDs (`basepad/postgres`). */
export const HOME_NAMESPACE = "basepad";

/**
 * basepad's home project: a mise project on the machine that owns the shared daemons, plus
 * basepad's records. Projects reference its daemons; they never run their own copies.
 */
export interface Home {
	dir: string;
	records: Records;
	save(): Promise<void>;
	/** Writes the home's `mise.toml` with these daemon tables, and trusts it. */
	configure(daemons: string): Promise<void>;
}

/** `$BASEPAD_HOME`, else `$XDG_DATA_HOME/basepad`, else `~/.local/share/basepad`. */
export function homeDir(): string {
	if (process.env.BASEPAD_HOME) return resolve(process.env.BASEPAD_HOME);
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(data, "basepad");
}

export async function openHome(): Promise<Home> {
	const dir = homeDir();
	const recordsFile = join(dir, "basepad.json");
	const records = await loadRecords(recordsFile);
	return {
		dir,
		records,
		save: () => saveRecords(recordsFile, records),
		async configure(daemons) {
			await mkdir(dir, { recursive: true });
			const file = join(dir, "mise.toml");
			const text = [
				"# basepad's home project. basepad rewrites this file; change services through basepad.",
				`min_version = "${MISE_MIN_VERSION}"`,
				"",
				"[settings]",
				"experimental = true",
				"",
				"[tools]",
				`postgres = "${POSTGRES_VERSION}"`,
				`pitchfork = "${PITCHFORK_VERSION}"`,
				"",
				"[daemons_settings]",
				`namespace = "${HOME_NAMESPACE}"`,
				"",
				daemons.trim(),
				"",
			].join("\n");
			const current = await readFile(file, "utf8").catch(() => "");
			if (current !== text) await writeFile(file, text);
			// basepad wrote every line of this file, so trusting it on the user's behalf is safe.
			await mise(dir, "trust", "--quiet", dir);
		},
	};
}

const LOCK_TIMEOUT_MS = 180_000;

/**
 * Runs `fn` with the home project to itself, so concurrent basepad commands (parallel worktrees,
 * agents) never initialise the cluster twice or lose each other's records.
 */
export async function withHome<T>(fn: (home: Home) => Promise<T>): Promise<T> {
	const dir = homeDir();
	await mkdir(dir, { recursive: true });
	const lock = join(dir, "basepad.lock");
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const handle = await open(lock, "wx");
			await handle.writeFile(String(process.pid));
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = Number(await readFile(lock, "utf8").catch(() => ""));
			if (holder && !alive(holder)) {
				await rm(lock, { force: true });
				continue;
			}
			if (Date.now() > deadline) {
				throw new BasepadError(
					`Another basepad command (pid ${holder || "unknown"}) holds ${lock}.`,
				);
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	try {
		return await fn(await openHome());
	} finally {
		await rm(lock, { force: true });
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
