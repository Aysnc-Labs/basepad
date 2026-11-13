import { expect, test } from "vitest";
import { type Hands, perform } from "../src/mission-control/act.ts";
import type { DaemonState } from "../src/supervisor.ts";

/** A supervisor that records what it is asked and answers `start` with the given states. */
function fake(states: Record<string, DaemonState> = {}) {
	const calls: string[] = [];
	const hands: Hands = {
		supervisor: {
			async hold(namespace, names) {
				calls.push(`hold ${namespace} ${names.join(",")}`);
			},
			async stop(namespace, names) {
				calls.push(`stop ${namespace} ${names?.join(",")}`);
			},
			async start(namespace, names) {
				calls.push(`start ${namespace} ${names.join(",")}`);
				return states;
			},
		},
		async open(url) {
			calls.push(`open ${url}`);
		},
		async copy(text) {
			calls.push(`copy ${text}`);
			return "the clipboard";
		},
		async worktrees(order) {
			calls.push(
				order.kind === "add"
					? "worktree add"
					: `worktree rm ${order.suffix}${order.force ? " --force" : ""}`,
			);
		},
	};
	return { calls, hands };
}

const web = { namespace: "shop", apps: ["web"], services: [], label: "web" };
const main = { namespace: "shop", apps: ["web", "api"], services: ["db"], label: "main" };

test("stop holds the apps, so no request starts them again, then stops apps and services", async () => {
	const { calls, hands } = fake();
	expect(await perform({ kind: "stop", ...main }, hands)).toBe("Stopped main.");
	expect(calls).toEqual(["hold shop web,api", "stop shop web,api,db"]);
});

test("start starts them, and says which failed", async () => {
	const ok = fake({ web: "running" });
	expect(await perform({ kind: "start", ...web }, ok.hands)).toBe("Started web.");
	expect(ok.calls).toEqual(["start shop web"]);
	const bad = fake({ web: "running", api: "failed", db: "running" });
	expect(await perform({ kind: "start", ...main }, bad.hands)).toBe(
		"main started, but api failed: its last lines are in the logs.",
	);
});

test("restart stops, then starts", async () => {
	const { calls, hands } = fake({ web: "running" });
	expect(await perform({ kind: "restart", ...web }, hands)).toBe("Restarted web.");
	expect(calls).toEqual(["stop shop web", "start shop web"]);
});

test("open and copy go to the desktop, and a failure says what to do instead", async () => {
	const { calls, hands } = fake();
	expect(await perform({ kind: "open", url: "https://web.shop.localhost" }, hands)).toBe(
		"Opened https://web.shop.localhost in the browser.",
	);
	expect(await perform({ kind: "copy", text: "postgresql://x" }, hands)).toBe(
		"Copied postgresql://x to the clipboard.",
	);
	expect(calls).toEqual(["open https://web.shop.localhost", "copy postgresql://x"]);
	hands.open = async () => {
		throw new Error("xdg-open not found");
	};
	expect(await perform({ kind: "open", url: "https://web.shop.localhost" }, hands)).toBe(
		"Could not open a browser (xdg-open not found). The URL: https://web.shop.localhost",
	);
});

test("a supervisor that fails says so, and never throws into the view", async () => {
	const { hands } = fake();
	hands.supervisor.stop = async () => {
		throw new Error("pitchfork exited 1");
	};
	expect(await perform({ kind: "stop", ...web }, hands)).toBe(
		"Could not stop web: pitchfork exited 1",
	);
});

test("a worktree's addition or removal starts its command and says it goes on without the view", async () => {
	const { calls, hands } = fake();
	expect(await perform({ kind: "add" }, hands)).toBe(
		"Adding a worktree: it goes on if you close the view.",
	);
	const removal = { kind: "remove", suffix: "shop-1", namespace: "shop.shop-1" } as const;
	expect(await perform({ ...removal, force: false }, hands)).toBe(
		"Removing shop-1: it goes on if you close the view.",
	);
	await perform({ ...removal, force: true }, hands);
	expect(calls).toEqual(["worktree add", "worktree rm shop-1", "worktree rm shop-1 --force"]);
});

test("a worktree command that cannot start says why, and never throws into the view", async () => {
	const { hands } = fake();
	hands.worktrees = async () => {
		throw new Error("spawn sh ENOENT");
	};
	expect(await perform({ kind: "add" }, hands)).toBe("Could not add a worktree: spawn sh ENOENT");
	expect(
		await perform(
			{ kind: "remove", suffix: "shop-1", namespace: "shop.shop-1", force: false },
			hands,
		),
	).toBe("Could not remove shop-1: spawn sh ENOENT");
});
