import { lookup } from "node:dns/promises";
import { access, constants, readFile, writeFile } from "node:fs/promises";

/**
 * Name resolution for server-side code. Browsers and curl resolve `*.localhost` themselves, and so
 * do macOS and Linux with systemd's resolver; glibc without it (a container) and musl do not. There
 * basepad adds the project's domains to the hosts file, or says which lines to add.
 */

const HOSTS_FILE = "/etc/hosts";

/** `text` with the project's block of domains set: replaced where it is, else appended. Pure. */
export function withHosts(text: string, name: string, hosts: string[]): string {
	const start = `# >>> basepad ${name}\n`;
	const end = `# <<< basepad ${name}\n`;
	const block = `${start}${hosts.map((host) => `127.0.0.1 ${host}\n`).join("")}${end}`;
	const at = text.indexOf(start);
	const until = at === -1 ? -1 : text.indexOf(end, at);
	if (at !== -1 && until !== -1) {
		return text.slice(0, at) + block + text.slice(until + end.length);
	}
	const gap = text === "" || text.endsWith("\n") ? "" : "\n";
	return `${text}${gap}${block}`;
}

/**
 * Makes the project's domains resolve: nothing when they already do (and no block of ours is
 * there to keep current), else writes its block when the file is writable, else returns the lines
 * for the developer to add. Returns what to tell them.
 */
export async function syncHosts(name: string, hosts: string[]): Promise<string[]> {
	if (hosts.length === 0) return [];
	const current = await readFile(HOSTS_FILE, "utf8").catch(() => undefined);
	if (current === undefined) return [];
	const ours = current.includes(`# >>> basepad ${name}\n`);
	if (!ours) {
		const missing = [];
		for (const host of hosts) if (!(await resolves(host))) missing.push(host);
		if (missing.length === 0) return [];
	}
	const text = withHosts(current, name, hosts);
	if (text === current) return [];
	if (!(await writable(HOSTS_FILE))) {
		return [
			`This system does not resolve ${name}'s domains for server-side code. Add to ${HOSTS_FILE}:`,
			...hosts.map((host) => `  127.0.0.1 ${host}`),
		];
	}
	// In place, not by rename: in a container the hosts file is a bind mount.
	await writeFile(HOSTS_FILE, text);
	return [`Added ${name}'s domains to ${HOSTS_FILE}.`];
}

async function resolves(host: string): Promise<boolean> {
	return lookup(host).then(
		() => true,
		() => false,
	);
}

async function writable(file: string): Promise<boolean> {
	return access(file, constants.W_OK).then(
		() => true,
		() => false,
	);
}
