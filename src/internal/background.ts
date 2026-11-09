import { spawn } from "node:child_process";
import { mkdir, open, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { hasConfig, noConfig } from "./config.ts";
import { homeDir, openHome } from "./home.ts";

/**
 * `basepad up --background`: starts `basepad up` for the project as a detached process, logging to
 * a file in basepad's home, and returns at once. A cloud session's start hook uses it, so the
 * session doesn't wait for the services.
 */
export async function upInBackground(cwd: string): Promise<string[]> {
	const projectDir = await realpath(cwd);
	if (
		!(await hasConfig(projectDir)) &&
		!(await openHome()).records.projects[projectDir]?.worktree
	) {
		throw noConfig();
	}
	const logs = join(homeDir(), "logs");
	await mkdir(logs, { recursive: true });
	const log = join(logs, `up-${basename(projectDir)}.log`);
	const file = await open(log, "w");
	try {
		const cli = process.argv[1] as string;
		const child = spawn(process.execPath, [cli, "up"], {
			cwd: projectDir,
			detached: true,
			stdio: ["ignore", file.fd, file.fd],
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.unref();
	} finally {
		await file.close();
	}
	return [
		`basepad is starting ${basename(projectDir)}'s services in the background; its log is ${log}. Run \`basepad status\` to see them.`,
	];
}
