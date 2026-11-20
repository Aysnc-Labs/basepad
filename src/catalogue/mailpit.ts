import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Kind, Place, Web } from "../catalogue.ts";
import { BasepadError, shellQuote } from "../internal/exec.ts";
import { answers, freePort, waitFor } from "../internal/ports.ts";
import { recordRunning, runningPort } from "../internal/processes.ts";
import { programsIn } from "../tools.ts";

const HOST = "127.0.0.1";
const PLACEHOLDER_PASSWORD = "basepad";
const READY_MS = 30_000;
const MAILPIT_TOOLS = { mailpit: { name: "mailpit", version: "1.33.1" } };

/** A Mailpit of the project's own, shared by its worktrees. */
export interface MailpitService {
	kind: "mailpit";
}

/**
 * Catches all mail the project sends. Its inbox is at `https://<key>.<name>.localhost`; each
 * message is tagged with the environment that sent it: `main`, or a worktree's suffix.
 */
export function mailpit(): MailpitService {
	return { kind: "mailpit" };
}

/** What a Mailpit service gives to `env`: where to send mail, and where to read it. */
export interface MailpitOutputs {
	/** `smtp://<user>:<password>@127.0.0.1:<port>`. */
	url: string;
	host: string;
	port: number;
	/** The environment's own SMTP user, `main` or a worktree's suffix: its mail's tag. */
	user: string;
	/** A placeholder: any password is accepted. */
	password: string;
	/** The inbox's URL. */
	inbox: string;
}

export interface MailpitNames {
	user: string;
	data: string;
	pid: string;
}

export const mailpitKind: Kind<MailpitService, MailpitOutputs, MailpitNames> = {
	schema: z.strictObject({ kind: z.literal("mailpit") }),

	web: true,

	programs: () => MAILPIT_TOOLS,

	names(_service, { dir, suffix }) {
		return { user: suffix ?? "main", data: join(dir, "mailpit.db"), pid: join(dir, "mailpit.pid") };
	},

	async prepare(_service, place) {
		const bin = (await programsIn(place.checkout, MAILPIT_TOOLS)).mailpit;
		await mkdir(place.dir, { recursive: true });
		const smtp = (await runningPort(place.pid)) ?? (await freePort(place.port));
		const argv = [
			bin,
			"--smtp",
			`${HOST}:${smtp}`,
			"--database",
			place.data,
			"--smtp-auth-accept-any",
			"--smtp-auth-allow-insecure",
			"--tags-username",
			"--smtp-disable-rdns",
			"--disable-version-check",
		];
		return {
			[place.daemon]: {
				run: `${recordRunning(place.pid, smtp)} && exec ${argv.map(shellQuote).join(" ")} --listen "${HOST}:$PORT"`,
				program: bin,
				dir: place.dir,
				port: webOf(place).port,
			},
		};
	},

	async provision(_service, place, { stopped }) {
		const port = await waitFor(
			async () => {
				const port = await runningPort(place.pid);
				if (port === undefined) throw new Error("It has not started.");
				if (!(await answers(port, [HOST]))) throw new Error(`Nothing answers on port ${port}.`);
				return port;
			},
			`Mailpit for \`${place.key}\` didn't answer within ${READY_MS / 1000} s.`,
			READY_MS,
			stopped,
		);
		return {
			url: `smtp://${place.user}:${PLACEHOLDER_PASSWORD}@${HOST}:${port}`,
			host: HOST,
			port,
			user: place.user,
			password: PLACEHOLDER_PASSWORD,
			inbox: webOf(place).url,
		};
	},

	async address(_service, place) {
		return webOf(place).url;
	},
};

function webOf(place: Place): Web {
	if (place.web === undefined) throw new BasepadError(`\`${place.key}\` has no domain.`);
	return place.web;
}
