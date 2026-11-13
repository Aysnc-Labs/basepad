import { spawn } from "node:child_process";
import type { Supervisor } from "../supervisor.ts";
import type { Intent } from "./model.ts";

/**
 * Where mission control's intents are done: the one place the view acts on what runs (through the
 * supervisor) and on the developer's desktop (browser and clipboard). Everything else it only reads.
 */
export interface Hands {
	supervisor: Pick<Supervisor, "start" | "stop" | "hold">;
	/** Opens a URL in the default browser. Throws when there is none to open it in. */
	open(url: string): Promise<void>;
	/** Puts text on the clipboard. Returns where it went (`the clipboard`). */
	copy(text: string): Promise<string>;
	/**
	 * `basepad worktree add` and `worktree rm` themselves, run from main, saying what they print to
	 * `print` rather than the terminal. Each rejects as its command fails.
	 */
	worktrees: {
		add(print: (line: string) => void): Promise<void>;
		remove(suffix: string, force: boolean, print: (line: string) => void): Promise<void>;
	};
}

/** How long a start waits for each daemon to listen or fail before it says how it went. */
const START_WAIT_MS = 10_000;

/**
 * Does what the developer asked. Resolves to what to tell them; never rejects. A worktree's
 * addition or removal, which takes a while, tells `progress` each line its command prints.
 */
export async function perform(
	intent: Intent,
	hands: Hands,
	progress: (line: string) => void = () => {},
): Promise<string> {
	const { supervisor } = hands;
	switch (intent.kind) {
		case "add":
		case "remove": {
			// The command's last line says how it ended: where the worktree is, or what was removed.
			let last = "";
			const print = (text: string) => {
				const line = text.split("\n").findLast((l) => l.trim() !== "");
				if (line === undefined) return;
				last = line;
				progress(line);
			};
			const done =
				intent.kind === "add"
					? hands.worktrees.add(print)
					: hands.worktrees.remove(intent.suffix, intent.force, print);
			const what = intent.kind === "add" ? "add a worktree" : `remove ${intent.suffix}`;
			return done.then(
				() => last,
				(error) => `Could not ${what}: ${firstAndLast(reason(error))}`,
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
			// Held first, as `basepad down` does, so no request starts an app again while it stops.
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

/** A message of several lines as one: its first and last, which say what failed and what next. */
function firstAndLast(message: string): string {
	const lines = message.split("\n").filter((l) => l.trim() !== "");
	return lines.length <= 2 ? lines.join(" ") : `${lines[0]} … ${lines.at(-1)}`;
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The developer's own desktop: `open` on macOS, `xdg-open` on Linux; the clipboard through the
 * platform's command, else through the terminal itself (OSC 52), which reaches the developer's
 * clipboard over SSH too, in terminals that allow it.
 */
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
			terminal.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
			return "the clipboard, through the terminal";
		},
	};
}

/** Runs a desktop command with `input` on its stdin. Rejects when it is missing or fails. */
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
