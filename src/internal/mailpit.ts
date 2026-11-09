import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { shellQuote, tomlString } from "./exec.ts";
import { HOME_NAMESPACE, type Home } from "./home.ts";
import { mise } from "./mise.ts";
import { freePort, waitFor } from "./ports.ts";
import { MAILPIT_TOOL, MAILPIT_VERSION, PITCHFORK_VERSION } from "./versions.ts";

/** The shared Mailpit's daemon name in the home project. */
export const MAILPIT_DAEMON = "mailpit";
export const MAILPIT_DAEMON_ID = `${HOME_NAMESPACE}/${MAILPIT_DAEMON}`;

/** Mailpit's own defaults, so its inbox is where people expect it unless that port is busy. */
const SMTP_PORT_BASE = 1025;
const UI_PORT_BASE = 8025;

/**
 * Mailpit accepts any password, but some mailers won't authenticate without one, and without
 * authenticating there's no username to tag the mail with.
 */
export const SMTP_PASSWORD = "basepad";

export interface MailServer {
	smtpPort: number;
	/** The SMTP URL for mail tagged `tag`: Mailpit tags each message with its sender's username. */
	smtpUrl(tag: string): string;
	/** The web inbox, which also serves Mailpit's API. */
	inbox: string;
}

/**
 * Brings up the shared Mailpit in the home project: one inbox for every project and worktree,
 * which tags each message with the SMTP username it was sent with. Its messages are kept in a file
 * in the home project, so they survive a restart.
 */
export async function startMailpit(home: Home): Promise<MailServer> {
	if (!home.records.mailpit) {
		home.records.mailpit = {
			smtpPort: await freePort(SMTP_PORT_BASE, home.records),
			uiPort: await freePort(UI_PORT_BASE, home.records),
		};
		await home.save();
	}
	const { smtpPort, uiPort } = home.records.mailpit;
	const state = join(home.dir, "mailpit");
	await mkdir(state, { recursive: true });

	await mise(
		home.dir,
		"install",
		"--quiet",
		`${MAILPIT_TOOL}@${MAILPIT_VERSION}`,
		`pitchfork@${PITCHFORK_VERSION}`,
	);
	const bin = (await mise(home.dir, "where", `${MAILPIT_TOOL}@${MAILPIT_VERSION}`)).trim();
	const argv = [
		join(bin, "mailpit"),
		"--smtp",
		`127.0.0.1:${smtpPort}`,
		"--listen",
		`127.0.0.1:${uiPort}`,
		"--database",
		join(state, "mailpit.db"),
		// Any username and password, over plain SMTP: the username becomes the message's tag.
		"--smtp-auth-accept-any",
		"--smtp-auth-allow-insecure",
		"--tags-username",
		"--disable-version-check",
	];
	await home.configure(MAILPIT_DAEMON, {
		tools: { [MAILPIT_TOOL]: MAILPIT_VERSION },
		table: [
			`[daemons.${MAILPIT_DAEMON}]`,
			`run = ${tomlString(`exec ${argv.map(shellQuote).join(" ")}`)}`,
			`port = ${uiPort}`,
			`ready_port = ${smtpPort}`,
			"proxy = false",
		].join("\n"),
	});
	await mise(home.dir, "daemons", "start", MAILPIT_DAEMON);

	const inbox = `http://127.0.0.1:${uiPort}`;
	await waitFor(async () => {
		const res = await fetch(`${inbox}/readyz`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) throw new Error(`${inbox}/readyz: HTTP ${res.status}`);
	}, `Mailpit didn't become ready. For its log, run \`mise daemons logs ${MAILPIT_DAEMON}\` in ${home.dir}.`);
	return {
		smtpPort,
		inbox,
		smtpUrl: (tag) => `smtp://${tag}:${SMTP_PASSWORD}@127.0.0.1:${smtpPort}`,
	};
}

/**
 * A mail tag from a project's or worktree's name. Mailpit's tags allow letters, digits, `-`, `.`,
 * `_`, space and `@`; spaces and `@` would need escaping in a URL, so they become `-` too.
 */
export function mailTag(name: string): string {
	const tag = name
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return tag || "basepad";
}
