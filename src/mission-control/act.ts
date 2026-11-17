import { spawn } from "node:child_process";
import type { Supervisor } from "../supervisor.ts";
import type { Intent } from "./model.ts";
import type { WorkOrder } from "./work.ts";

export interface Hands {
	supervisor: Pick<Supervisor, "start" | "stop" | "hold">;
	open(url: string): Promise<void>;
	copy(text: string): Promise<string>;
	worktrees(order: WorkOrder): Promise<void>;
}

const START_WAIT_MS = 10_000;

export async function perform(intent: Intent, hands: Hands): Promise<string> {
	const { supervisor } = hands;
	switch (intent.kind) {
		case "add":
		case "remove": {
			const doing = intent.kind === "add" ? "Adding a worktree" : `Removing ${intent.suffix}`;
			const what = intent.kind === "add" ? "add a worktree" : `remove ${intent.suffix}`;
			return hands.worktrees(intent).then(
				() => `${doing}: it goes on if you close the view.`,
				(error) => `Could not ${what}: ${reason(error)}`,
			);
		}
		case "open":
			return hands.open(intent.url).then(
				() => `Opened ${intent.url} in the browser.`,
				(error) => `Could not open a browser (${reason(error)}). The URL: ${intent.url}`,
			);
		case "copy":
			return hands.copy(intent.text).then(
				(where) => `Copied ${intent.text} to ${where}.`,
				(error) => `Could not copy (${reason(error)}). It is: ${intent.text}`,
			);
	}
	const { kind, namespace, apps, services, label } = intent;
	const names = [...apps, ...services];
	try {
		if (kind === "stop") {
			await supervisor.hold(namespace, apps);
			await supervisor.stop(namespace, names);
			return `Stopped ${label}.`;
		}
		if (kind === "restart") await supervisor.stop(namespace, names);
		const states = await supervisor.start(namespace, names, START_WAIT_MS, {});
		const failed = names.filter((name) => states[name] === "failed");
		if (failed.length > 0) {
			const which = failed.length === 1 && failed[0] === label ? "it" : failed.join(", ");
			return `${label} ${kind === "start" ? "started" : "restarted"}, but ${which} failed: its last lines are in the logs.`;
		}
		return `${kind === "start" ? "Started" : "Restarted"} ${label}.`;
	} catch (error) {
		return `Could not ${kind} ${label}: ${reason(error)}`;
	}
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function desktopHands(
	supervisor: Hands["supervisor"],
	worktrees: Hands["worktrees"],
	terminal: { write(text: string): unknown },
): Hands {
	const mac = process.platform === "darwin";
	const clipboards: [string, string[]][] = mac
		? [["pbcopy", []]]
		: [
				...(process.env.WAYLAND_DISPLAY ? [["wl-copy", []] as [string, string[]]] : []),
				...(process.env.DISPLAY
					? [
							["xclip", ["-selection", "clipboard"]] as [string, string[]],
							["xsel", ["--clipboard", "--input"]] as [string, string[]],
						]
					: []),
			];
	return {
		supervisor,
		worktrees,
		async open(url) {
			await runWith(mac ? "open" : "xdg-open", [url]);
		},
		async copy(text) {
			for (const [command, args] of clipboards) {
				const done = await runWith(command, args, text).then(
					() => true,
					() => false,
				);
				if (done) return "the clipboard";
			}
			terminal.write(osc52Copy(text));
			return "the clipboard, through the terminal";
		},
	};
}

function osc52Copy(text: string): string {
	return `\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`;
}

function runWith(command: string, args: string[], input?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
		});
		child.on("error", (error: NodeJS.ErrnoException) =>
			reject(new Error(error.code === "ENOENT" ? `${command} not found` : error.message)),
		);
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
		);
		child.stdin?.end(input);
	});
}
