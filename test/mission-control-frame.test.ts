import { renderToString } from "ink";
import { expect, test } from "vitest";
import { frame } from "../src/mission-control/frame.ts";
import {
	type EnvironmentView,
	initialView,
	type LogLine,
	type Part,
	type Snapshot,
	type View,
} from "../src/mission-control/model.ts";

const url = (app: string, suffix?: string) =>
	`https://${app}.${suffix === undefined ? "" : `${suffix}.`}shop.localhost:7443`;

const app = (namespace: string, name: string, over: Partial<Part> = {}): Part => ({
	id: `${namespace}/${name}`,
	name,
	state: "running",
	address: url(name, namespace.split(".")[1]),
	note: ":20001  pid 4242",
	...over,
});
const db: Part = {
	id: "shop/db",
	name: "db",
	state: "running",
	address: "postgresql://postgres@127.0.0.1:15432/shop",
	note: "postgres",
};
const main: EnvironmentView = {
	namespace: "shop",
	label: "main",
	branch: "main",
	dir: "/code/shop",
	apps: [app("shop", "web"), app("shop", "api")],
	services: [db],
};
const worktree = (n: number, over: Partial<EnvironmentView> = {}): EnvironmentView => {
	const ns = `shop.worktree-${n}`;
	return {
		namespace: ns,
		label: `worktree-${n}`,
		branch: `feature/thing-${n}`,
		dir: `/code/shop.worktrees/worktree-${n}`,
		apps: [app(ns, "web"), app(ns, "api")],
		services: [{ ...db, address: `postgresql://postgres@127.0.0.1:15432/shop_worktree_${n}` }],
		...over,
	};
};

let seq = 0;
const lines = (id: string, ...texts: string[]): [string, LogLine[]] => [
	id,
	texts.map((text) => ({ seq: seq++, id, time: "10:00:00", text })),
];

const snap = (environments: EnvironmentView[], logs: [string, LogLine[]][] = []): Snapshot => ({
	project: "shop",
	environments,
	logs: new Map(logs),
	rate: 12,
});

/** The frame as plain text, a line per row, without trailing spaces. */
function draw(snapshot: Snapshot, view: View = initialView("shop"), cols = 140, rows = 40): string {
	const text = renderToString(
		frame({ snapshot, view, cols, rows, now: "10:00:05", color: false }),
		{
			columns: cols,
		},
	);
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

test("main only: the header names the project and counts, main is listed, its parts show state and address", () => {
	const out = draw(snap([main], [lines("shop/web", "GET / 200 3ms"), lines("shop/api", "ready")]));
	expect(out).toMatch(/basepad.*shop.*2 running/);
	expect(out).toContain("10:00:05");
	expect(out).toMatch(/│ ▌● main +│.*\n│ ▌ {2}main +│/); // selected: its name, then its branch
	expect(out).toMatch(/web +running +https:\/\/web\.shop\.localhost:7443 +:20001 +pid 4242/);
	expect(out).toMatch(/db +running +postgresql:\/\/postgres@127\.0\.0\.1:15432\/shop +postgres/);
	expect(out).toMatch(/10:00:00 +▎web +GET \/ 200 3ms/);
	expect(out).toMatch(/10:00:00 +▎api +ready/);
	expect(out.split("\n")).toHaveLength(40);
});

test("main with three worktrees: each is listed with its branch, and the selected one's parts are shown", () => {
	const out = draw(
		snap([main, worktree(1), worktree(2), worktree(3)]),
		initialView("shop.worktree-2"),
	);
	for (const n of [1, 2, 3])
		expect(out).toMatch(new RegExp(`● worktree-${n}[\\s\\S]*feature/thing-${n}`));
	expect(out).toMatch(/│ ▌● worktree-2 /);
	expect(out).not.toMatch(/▌● main/);
	expect(out).toContain("worktree-2  · feature/thing-2");
	expect(out).toContain("https://web.worktree-2.shop.localhost:7443");
	expect(out).toContain("postgresql://postgres@127.0.0.1:15432/shop_worktree_2");
	expect(out).toContain("4 environments");
	expect(out).toContain("8 running");
});

test("an errored app stands out: an alert line names it and its error wherever the view is, and its row says failed", () => {
	const api = app("shop.worktree-1", "api", {
		state: "failed",
		error: "exit code 1",
		note: undefined,
	});
	const broken = worktree(1, { apps: [app("shop.worktree-1", "web"), api] });
	const logs = [
		lines(
			api.id,
			"api listening",
			"TypeError: Cannot read properties of undefined",
			"    at server.mjs:3",
		),
	];
	const onMain = draw(snap([main, broken], logs));
	expect(onMain).toMatch(
		/✖ worktree-1 › api exited \(exit code 1\) +TypeError: Cannot read properties of undefined/,
	);
	expect(onMain).toContain("1 failed");
	expect(onMain).toMatch(/✖ worktree-1[\s\S]*api failed/); // its environment, in the sidebar
	const onIt = draw(snap([main, broken], logs), initialView("shop.worktree-1"));
	expect(onIt).toMatch(/✖ api +failed +exit code 1 +TypeError: Cannot read properties/);
});

test("an idle worktree reads as idle, not failed: its apps start on their first request", () => {
	const ns = "shop.worktree-2";
	const idle = worktree(2, {
		apps: [
			app(ns, "web", { state: "idle", note: undefined }),
			app(ns, "api", { state: "idle", note: undefined }),
		],
	});
	const out = draw(snap([main, idle]), initialView(ns));
	expect(out).toMatch(/○ worktree-2[\s\S]*idle until opened/);
	expect(out).toMatch(
		/○ web +idle +https:\/\/web\.worktree-2\.shop\.localhost:7443 +starts on its first request/,
	);
	expect(out).not.toContain("failed");
	expect(out).toContain("No output yet: its apps start on their first request.");
	expect(out).toContain("2 idle");
});

test("a very long branch name wraps in the sidebar and is never cut", () => {
	const branch = "feature/JIRA-12345-rework-the-checkout-flow-for-guest-customers";
	const out = draw(snap([main, worktree(1, { branch })]));
	const sidebar = out
		.split("\n")
		.map((row) => /^│ [ ▌] {2}(\S*)/.exec(row)?.[1] ?? "")
		.join("");
	expect(sidebar).toContain(branch);
	expect(out).toMatch(/│ {4}feature\/JIRA-12345- +│/); // broken after a dash, not mid-word
	expect(out).not.toMatch(/^│[^│]*…/m);
});

test("focusing one part narrows the stream to its lines, without the name column", () => {
	const logs = [lines("shop/web", "GET / 200 3ms"), lines("shop/api", "POST /orders 201")];
	const out = draw(snap([main], logs), { ...initialView("shop"), focus: "shop/api" });
	expect(out).toContain("LOGS  api only");
	expect(out).toMatch(/› ● api/);
	expect(out).toMatch(/10:00:00 +POST \/orders 201/);
	expect(out).not.toContain("GET / 200 3ms");
});

test("the keys are on screen", () => {
	const out = draw(snap([main]));
	expect(out).toMatch(/↑↓ +environment +←→ +app or service +esc +all logs +q +close/);
});

test("a terminal too small for the layout says how big it must be", () => {
	const out = draw(snap([main]), initialView("shop"), 60, 12);
	expect(out).toContain("needs 72×16; this terminal is 60×12");
});

test("at 100 columns an app's whole URL still shows: the state word gives way, its glyph stays", () => {
	const ns = "shop.worktree-1";
	const wide = worktree(1, { apps: [app(ns, "worker"), app(ns, "web")] });
	const out = draw(snap([main, wide]), initialView(ns), 100, 30);
	expect(out).toMatch(/● worker +https:\/\/worker\.worktree-1\.shop\.localhost:7443/);
	expect(out).not.toMatch(/localhost:744…/);
});
