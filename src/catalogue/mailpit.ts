import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Kind, Place, Web } from "../catalogue.ts";
import { BasepadError, shellQuote } from "../internal/exec.ts";
import { answers, freePort, waitFor } from "../internal/ports.ts";
import { recordRunning, runningPort } from "../internal/processes.ts";
import { install } from "../tools.ts";
import { MAILPIT_VERSION } from "../versions.ts";

/**
 * Mailpit: one inbox per project, which catches every message the project's environments send.
 * Its inbox is its domain; its SMTP server is on loopback. Main and every worktree share it, and
 * each sends as its own SMTP user, which Mailpit tags each message with. Its messages are kept in
 * the service's folder, so they survive a restart.
 */

const HOST = "127.0.0.1";
/** Mailpit accepts any password, but some mailers authenticate only with one. */
const PASSWORD = "basepad";
/** How long `up` waits for its SMTP server to answer before it gives up. */
const READY_MS = 30_000;

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

/** The names a Mailpit service derives. */
export interface MailpitNames {
	/** The environment's SMTP user: `main`, or a worktree's suffix. */
	user: string;
	/** Mailpit's database of messages, in the service's folder. */
	data: string;
	/** Where the running Mailpit's process id and SMTP port are written as it starts. */
	pid: string;
}

export const mailpitKind: Kind<MailpitService, MailpitOutputs, MailpitNames> = {
	schema: z.strictObject({ kind: z.literal("mailpit") }),

	web: true,

	names(_service, { dir, suffix }) {
		return { user: suffix ?? "main", data: join(dir, "mailpit.db"), pid: join(dir, "mailpit.pid") };
	},

	async prepare(_service, place) {
		const bin = (await install("mailpit", MAILPIT_VERSION, place.machine.home)).bin("mailpit");
		await mkdir(place.dir, { recursive: true });
		const smtp = (await runningPort(place.pid)) ?? (await freePort(place.port));
		const argv = [
			bin,
			"--smtp",
			`${HOST}:${smtp}`,
			"--database",
			place.data,
			// Any user and password, over plain SMTP on loopback: the user becomes the message's tag.
			"--smtp-auth-accept-any",
			"--smtp-auth-allow-insecure",
			"--tags-username",
			"--smtp-disable-rdns",
			"--disable-version-check",
		];
		return {
			run: `${recordRunning(place.pid, smtp)} && exec ${argv.map(shellQuote).join(" ")} --listen "${HOST}:$PORT"`,
			dir: place.dir,
			port: webOf(place).port,
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
			url: `smtp://${place.user}:${PASSWORD}@${HOST}:${port}`,
			host: HOST,
			port,
			user: place.user,
			password: PASSWORD,
			inbox: webOf(place).url,
		};
	},

	// One inbox for the project: a worktree has no data of its own.
	async worktreeData() {
		return [];
	},

	async dropWorktreeData() {},

	async address(_service, place) {
		return webOf(place).url;
	},
};

function webOf(place: Place): Web {
	if (place.web === undefined) throw new BasepadError(`\`${place.key}\` has no domain.`);
	return place.web;
}
