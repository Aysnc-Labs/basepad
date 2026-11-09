import { lookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { APP_DAEMON, loadConfig } from "./config.ts";
import { exec, must, tomlString } from "./exec.ts";
import { type Home, openHome, withHome } from "./home.ts";
import { MAILPIT_DAEMON_ID } from "./mailpit.ts";
import { type Daemon, daemons } from "./mise.ts";
import type { Project, Records } from "./records.ts";
import { PITCHFORK_VERSION } from "./versions.ts";

/**
 * Localhost names, from pitchfork's proxy: every daemon with a port is served at
 * `<daemon>.<project>.localhost`, or `<daemon>.<worktree>.<project>.localhost` in a worktree, on
 * the proxy's port. basepad turns the proxy on, runs the app as a daemon, labels each worktree, and
 * keeps `/etc/hosts` in step where the system can't resolve `*.localhost` itself.
 */

/** What basepad sets when the machine hasn't configured pitchfork's proxy: plain HTTP on 8088. */
const PROXY_DEFAULTS = { enable: "true", https: "false", port: "8088" } as const;

/** pitchfork's user config, where `[settings.proxy]` must live: a project's own is ignored. */
function pitchforkUserConfig(): string {
	const dir = process.env.PITCHFORK_CONFIG_DIR || join(homedir(), ".config", "pitchfork");
	return join(dir, "config.toml");
}
const PITCHFORK_SYSTEM_CONFIG = "/etc/pitchfork/config.toml";

/**
 * Turns pitchfork's proxy on in its user config, unless the machine already says whether it's on.
 * Settings the machine already has (its port, HTTPS) are kept. Must run before pitchfork's
 * supervisor starts, since it reads them once.
 */
export async function ensureProxy(home: Home): Promise<void> {
	const user = await proxySettings(pitchforkUserConfig());
	const system = await proxySettings(PITCHFORK_SYSTEM_CONFIG);
	if ("enable" in user || "enable" in system) return;
	for (const [key, value] of Object.entries(PROXY_DEFAULTS)) {
		if (key in user || key in system) continue;
		// Through pitchfork, which takes its own lock on the file it also writes.
		await must(
			"mise",
			[
				"exec",
				`pitchfork@${PITCHFORK_VERSION}`,
				"--",
				"pitchfork",
				"settings",
				"set",
				`proxy.${key}`,
				value,
				"--global",
			],
			{ cwd: home.dir },
		);
	}
}

async function proxySettings(file: string): Promise<Record<string, unknown>> {
	const text = await readFile(file, "utf8").catch(() => undefined);
	if (text === undefined) return {};
	try {
		const settings = (parse(text) as { settings?: { proxy?: Record<string, unknown> } }).settings;
		return settings?.proxy ?? {};
	} catch {
		return {};
	}
}

/**
 * The app's daemon table: the project's dev server on basepad's port (pitchfork passes it as
 * `PORT`), so the proxy names it. No `ready_port`: pitchfork would wait minutes on an app that
 * never listens, so basepad waits itself, briefly.
 */
export function appDaemon(run: string, port: number): string {
	return [
		`[daemons.${APP_DAEMON}]`,
		`run = ${tomlString(run)}`,
		`port = ${port}`,
		// The name's first label: `app.<project>.localhost`.
		'proxy = "app"',
	].join("\n");
}

type Worktree = NonNullable<Project["worktree"]>;

/**
 * Gives a worktree its label, the middle of its names: its own name, folded to what a host name
 * allows, and made unique in its repo (pitchfork routes no name that two checkouts share). Written
 * as `worktree_label` in the worktree's `pitchfork.local.toml`, since the directory name would be
 * `<main>-<name>`.
 */
export async function labelWorktree(home: Home, worktree: Worktree): Promise<void> {
	if (worktree.label === undefined) {
		const taken = new Set(
			Object.values(home.records.projects).flatMap((p) =>
				p.worktree?.mainRoot === worktree.mainRoot &&
				p.worktree.root !== worktree.root &&
				p.worktree.label !== undefined
					? [p.worktree.label]
					: [],
			),
		);
		const base =
			worktree.name
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 50) || "worktree";
		let label = base;
		for (let n = 2; taken.has(label); n++) label = `${base}-${n}`;
		worktree.label = label;
		await home.save();
	}
	const file = labelFile(worktree.root);
	const current = await readFile(file, "utf8").catch(() => "");
	const line = `worktree_label = ${tomlString(worktree.label)}`;
	const key = /^worktree_label\s*=.*$/m;
	const text = key.test(current) ? current.replace(key, line) : `${line}\n${current}`;
	if (text !== current) await writeFile(file, text);
}

/** The worktree's `pitchfork.local.toml`, which basepad writes and removes with it. */
export function labelFile(root: string): string {
	return join(root, "pitchfork.local.toml");
}

/**
 * Starts the project's app daemon, if it has one, then records the project's names and brings
 * `/etc/hosts` in step. Returns what it did, for the command's output.
 */
export async function serve(projectDir: string): Promise<string[]> {
	const config = await loadConfig(projectDir);
	const lines: string[] = [];
	if (config.app) {
		const start = await exec("mise", ["daemons", "start", APP_DAEMON], { cwd: projectDir });
		const port = (await openHome()).records.projects[projectDir]?.app?.port;
		if (start.code !== 0 || port === undefined || !(await listensWithin(port, APP_WAIT_MS))) {
			lines.push(
				`The app isn't listening on its port${port === undefined ? "" : ` (${port})`} yet. It should listen on \`$PORT\`; for its log, run \`mise daemons logs ${APP_DAEMON}\` in ${projectDir}.`,
			);
		}
	}
	await withHome(async (home) => {
		const project = home.records.projects[projectDir];
		if (!project) return;
		const own = (await daemons(projectDir)) ?? [];
		const shared = config.services.some((s) => s.type === "mailpit")
			? ((await daemons(home.dir)) ?? [])
			: [];
		const app = config.app ? appOf(own, projectDir) : undefined;
		const inbox = shared.find((d) => d.id === MAILPIT_DAEMON_ID);
		const named = [app, inbox].filter((d): d is Daemon & { host: string; url: string } =>
			Boolean(d?.host && d.url),
		);
		project.hosts = named.map((d) => d.host);
		await home.save();
		for (const daemon of named) {
			lines.push(`${daemon === app ? "The app" : "The inbox"} is at ${daemon.url}.`);
		}
		const proxy = named[0] && new URL(named[0].url);
		const proxyPort = Number(proxy?.port || 80);
		if (proxy && (await listening(proxyPort))) {
			// pitchfork finds a new worktree within a couple of seconds; be ready when we say so.
			for (const daemon of named) await routed(proxyPort, daemon.host);
		} else if (proxy) {
			lines.push(
				`pitchfork's proxy isn't serving on port ${proxy.port || 80}, so the names don't answer yet. Restart pitchfork's supervisor with \`mise exec pitchfork@${PITCHFORK_VERSION} -- pitchfork supervisor start --force\` (it stops running daemons), then run \`basepad up\`.`,
			);
		}
		lines.push(...(await syncHosts(home)));
	});
	return lines;
}

/** Stops the project's app daemon, if it runs one. */
export async function stopApp(projectDir: string): Promise<string[]> {
	const config = await loadConfig(projectDir);
	if (!config.app) return [];
	const stop = await exec("mise", ["daemons", "stop", APP_DAEMON], { cwd: projectDir });
	return [stop.code === 0 ? "Stopped the app." : `Couldn't stop the app: ${stop.stderr.trim()}`];
}

/** The project's app daemon, as mise lists it, with its name and its URL there. */
export function appOf(own: Daemon[], projectDir: string): Daemon | undefined {
	return own.find((d) => d.root === projectDir && d.name === APP_DAEMON);
}

/** A daemon's name URL, when the proxy routes it. */
export function nameUrl(daemon: Daemon | undefined): string {
	return daemon?.host && daemon.url ? daemon.url : "-";
}

const HOSTS_FILE = "/etc/hosts";

/**
 * Keeps basepad's block in `/etc/hosts` in step with every name it has recorded. The block is
 * written only where a name doesn't resolve and basepad runs as root (a minimal container); macOS
 * and systemd-resolved Linux resolve `*.localhost` themselves. Each home has its own block.
 */
export async function syncHosts(home: Home): Promise<string[]> {
	const names = hostsOf(home.records);
	const start = `# >>> basepad names (${home.dir})`;
	const end = `# <<< basepad names (${home.dir})`;
	const current = await readFile(HOSTS_FILE, "utf8").catch(() => undefined);
	if (current === undefined) return [];
	const at = current.indexOf(`${start}\n`);
	const until = at === -1 ? -1 : current.indexOf(`${end}\n`, at);
	const hasBlock = at !== -1 && until !== -1;
	if (!hasBlock) {
		const unresolved = [];
		for (const name of names) if (!(await resolves(name))) unresolved.push(name);
		if (unresolved.length === 0) return [];
		if (process.getuid?.() !== 0) {
			return [
				`This system doesn't resolve ${unresolved.join(", ")}. Add \`127.0.0.1 ${unresolved.join(" ")}\` to ${HOSTS_FILE}, or open the names in a browser, which resolves them itself.`,
			];
		}
	}
	const block = names.length === 0 ? "" : [start, ...names.map((n) => `127.0.0.1 ${n}`), end, ""];
	const rest = hasBlock ? current.slice(0, at) + current.slice(until + end.length + 1) : current;
	const text =
		block === ""
			? rest
			: `${rest}${rest === "" || rest.endsWith("\n") ? "" : "\n"}${block.join("\n")}`;
	if (text === current) return [];
	// In place, not by rename: in a container, /etc/hosts is a mount.
	await writeFile(HOSTS_FILE, text);
	return names.length === 0 ? [] : [`Wrote ${names.length} names to ${HOSTS_FILE}.`];
}

function hostsOf(records: Records): string[] {
	const all = Object.values(records.projects).flatMap((p) => p.hosts ?? []);
	return [...new Set(all)].sort();
}

async function resolves(name: string): Promise<boolean> {
	try {
		await lookup(name);
		return true;
	} catch {
		return false;
	}
}

/** Waits, briefly, until pitchfork's proxy has a route for `host`: its answer isn't "No route". */
async function routed(port: number, host: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const answer = await new Promise<boolean>((resolve) => {
			const req = request(
				{ host: "127.0.0.1", port, path: "/", headers: { host }, timeout: 2000 },
				(res) => {
					let body = "";
					res.setEncoding("utf8").on("data", (chunk: string) => {
						body += chunk;
					});
					res.on("end", () => resolve(!(res.statusCode === 404 && body.includes("No route for"))));
				},
			);
			req.on("timeout", () => req.destroy());
			req.on("error", () => resolve(false));
			req.end();
		});
		if (answer) return;
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** How long `serve` waits for a dev server to listen: long enough for a cold start. */
const APP_WAIT_MS = 30_000;

async function listensWithin(port: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await listening(port)) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

function listening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(1000);
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.on("error", () => resolve(false));
	});
}
