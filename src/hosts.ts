import { lookup } from "node:dns/promises";
import { access, constants, readFile, writeFile } from "node:fs/promises";

const HOSTS_FILE = "/etc/hosts";

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

export function withoutHosts(text: string, name: string): string {
	const start = `# >>> basepad ${name}\n`;
	const end = `# <<< basepad ${name}\n`;
	const at = text.indexOf(start);
	const until = at === -1 ? -1 : text.indexOf(end, at);
	if (at === -1 || until === -1) return text;
	return text.slice(0, at) + text.slice(until + end.length);
}

export async function dropHosts(name: string): Promise<void> {
	const current = await readFile(HOSTS_FILE, "utf8").catch(() => undefined);
	if (current === undefined) return;
	const text = withoutHosts(current, name);
	if (text !== current) await writeHostsInPlace(text);
}

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
	if (await writeHostsInPlace(text)) return [`Added ${name}'s domains to ${HOSTS_FILE}.`];
	return [
		`This system does not resolve ${name}'s domains for server-side code. Add to ${HOSTS_FILE}:`,
		...hosts.map((host) => `  127.0.0.1 ${host}`),
	];
}

async function resolves(host: string): Promise<boolean> {
	return lookup(host).then(
		() => true,
		() => false,
	);
}

async function writeHostsInPlace(text: string): Promise<boolean> {
	const writable = await access(HOSTS_FILE, constants.W_OK).then(
		() => true,
		() => false,
	);
	if (writable) await writeFile(HOSTS_FILE, text);
	return writable;
}
