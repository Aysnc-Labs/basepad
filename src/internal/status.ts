import { access, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { openHome } from "./home.ts";
import { MAILPIT_DAEMON_ID, mailTag } from "./mailpit.ts";
import { type Daemon, daemons } from "./mise.ts";
import { NEON_ENDPOINT_OPTIONS, NEON_PROXY_DAEMON, NEON_PROXY_DAEMON_ID } from "./neon.ts";
import { POSTGRES_DAEMON_ID } from "./postgres.ts";
import { redisUrl } from "./redis.ts";

export interface Status {
	table: string;
	warnings: string[];
}

/**
 * `basepad status`: the project's basepad services, then its own mise daemons, each with
 * mise's state, its port and its URL. Passwords in URLs are masked.
 */
export async function status(cwd: string): Promise<Status> {
	const projectDir = await realpath(cwd);
	const config = await loadConfig(projectDir);
	const home = await openHome();
	const project = home.records.projects[projectDir];
	const warnings: string[] = [];
	const rows: string[][] = [];

	const shared = (await exists(join(home.dir, "mise.toml")))
		? ((await daemons(home.dir)) ?? [])
		: [];
	const own = await daemons(projectDir);
	if (own === undefined) {
		warnings.push(
			`basepad: this project's mise config isn't trusted, so its own daemons aren't listed. Review it, then run \`mise trust\`.`,
		);
	}
	const ownDaemons = (own ?? []).filter((d) => d.root === projectDir);
	const state = (daemon: Daemon | undefined) => daemon?.status ?? "missing";
	const port = (value: number | undefined) => (value === undefined ? "-" : String(value));

	for (const service of config.services) {
		const record = project?.services[service.name];
		switch (service.type) {
			case "postgres":
			case "postgres-neon": {
				const daemon = shared.find((d) => d.id === POSTGRES_DAEMON_ID);
				const server = home.records.postgres;
				const options = service.type === "postgres-neon" ? `?${NEON_ENDPOINT_OPTIONS}` : "";
				for (const database of service.databases ?? [service.name]) {
					const name = record?.type === service.type ? record.databases[database] : undefined;
					rows.push([
						service.databases === undefined ? service.name : `${service.name}/${database}`,
						name === undefined ? "missing" : state(daemon),
						port(server?.port),
						server === undefined || name === undefined
							? "-"
							: `postgres://postgres:***@localhost:${server.port}/${name}${options}`,
					]);
				}
				break;
			}
			case "mailpit": {
				const daemon = shared.find((d) => d.id === MAILPIT_DAEMON_ID);
				const server = home.records.mailpit;
				const tag = mailTag(project?.worktree?.name ?? basename(projectDir));
				rows.push(
					[
						service.name,
						record ? state(daemon) : "missing",
						port(server?.smtpPort),
						server ? `smtp://${tag}:***@127.0.0.1:${server.smtpPort}` : "-",
					],
					[
						`${service.name}/inbox`,
						record ? state(daemon) : "missing",
						port(server?.uiPort),
						server ? `http://127.0.0.1:${server.uiPort}` : "-",
					],
				);
				break;
			}
			case "redis": {
				const daemon = ownDaemons.find((d) => d.name === service.name);
				const recorded = record?.type === "redis" ? record.port : undefined;
				const shared = record?.type === "redis" && record.shared;
				rows.push([
					service.name,
					recorded === undefined ? "missing" : shared ? "shared" : state(daemon),
					port(recorded),
					recorded === undefined ? "-" : redisUrl(recorded),
				]);
				break;
			}
		}
	}

	if (config.services.some((s) => s.type === "postgres-neon")) {
		const daemon = shared.find((d) => d.id === NEON_PROXY_DAEMON_ID);
		const wss = home.records.neonProxy?.wss;
		rows.push([
			NEON_PROXY_DAEMON,
			wss === undefined ? "missing" : state(daemon),
			port(wss),
			wss === undefined ? "-" : `ws://localhost:${wss}/v2`,
		]);
	}

	const managed = new Set(config.services.map((s) => s.name));
	for (const daemon of ownDaemons) {
		if (managed.has(daemon.name)) continue;
		rows.push([
			daemon.name,
			daemon.status,
			daemon.port == null ? "-" : String(daemon.port),
			daemon.url ?? "-",
		]);
	}

	if (rows.length === 0)
		return { table: "No services yet. Add one with `basepad add <service>`.", warnings };
	return { table: format([["SERVICE", "STATE", "PORT", "URL"], ...rows]), warnings };
}

function format(rows: string[][]): string {
	const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
	return rows
		.map((row) =>
			row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
		)
		.join("\n");
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
