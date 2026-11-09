import { access, realpath } from "node:fs/promises";
import { openHome } from "./home.ts";
import { daemons } from "./mise.ts";
import { POSTGRES_DAEMON_ID } from "./postgres.ts";

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
	const home = await openHome();
	const project = home.records.projects[projectDir];
	const warnings: string[] = [];
	const rows: string[][] = [];

	const shared = (await exists(home.dir)) ? ((await daemons(home.dir)) ?? []) : [];
	for (const [name, service] of Object.entries(project?.services ?? {})) {
		const daemon = shared.find((d) => d.id === POSTGRES_DAEMON_ID);
		const port = home.records.postgres?.port;
		rows.push([
			name,
			daemon?.status ?? "missing",
			port === undefined ? "-" : String(port),
			port === undefined ? "-" : `postgres://postgres:***@localhost:${port}/${service.database}`,
		]);
	}

	const own = await daemons(projectDir);
	if (own === undefined) {
		warnings.push(
			`basepad: this project's mise config isn't trusted, so its own daemons aren't listed. Review it, then run \`mise trust\`.`,
		);
	}
	for (const daemon of own ?? []) {
		if (daemon.root !== projectDir) continue;
		rows.push([
			daemon.name,
			daemon.status,
			daemon.port == null ? "-" : String(daemon.port),
			daemon.url ?? "-",
		]);
	}

	if (rows.length === 0)
		return { table: "No services yet. Add one with `basepad add postgres`.", warnings };
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
