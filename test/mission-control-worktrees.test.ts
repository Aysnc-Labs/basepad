import { expect, test } from "vitest";
import {
	type EnvironmentView,
	initialView,
	type Part,
	type Press,
	reduce,
	type Snapshot,
	type View,
} from "../src/mission-control/model.ts";

const part = (id: string): Part => ({
	id,
	name: id.split("/")[1] as string,
	state: "running",
	address: `https://${id.split("/")[1]}.shop.localhost`,
});
const env = (namespace: string, over: Partial<EnvironmentView> = {}): EnvironmentView => ({
	namespace,
	label: namespace.split(".")[1] ?? "main",
	dir: `/code/${namespace}`,
	apps: [part(`${namespace}/web`)],
	services: [part("shop/db")],
	...over,
});
const snapshot: Snapshot = {
	project: "shop",
	environments: [env("shop"), env("shop.shop-1"), env("shop.shop-2", { changes: true })],
	logs: new Map(),
	rate: 0,
};

/** The keys pressed in turn, from `from`: the last view, and the intent of the last key. */
function press(keys: Press[], from: View = initialView("shop.shop-1"), on = snapshot) {
	let step = { view: from } as ReturnType<typeof reduce>;
	for (const key of keys) step = reduce(step.view, key, on);
	return step;
}

test("d on a worktree asks first, naming it; y removes it, keeping uncommitted work safe", () => {
	const asked = press(["d"]);
	expect(asked.intent).toBeUndefined();
	expect(asked.view.confirm).toEqual({
		namespace: "shop.shop-1",
		suffix: "shop-1",
		step: "remove",
	});
	expect(press(["d", "y"]).intent).toEqual({
		kind: "remove",
		suffix: "shop-1",
		namespace: "shop.shop-1",
		force: false,
	});
	expect(press(["d", "y"]).view.confirm).toBeUndefined();
});

test("only y goes on: n, escape, another d or any other key keeps the worktree and says so", () => {
	for (const key of ["n", "escape", "d", "Y", "return", "x", "q"]) {
		const step = press(["d", key]);
		expect(step.intent).toBeUndefined();
		expect(step.view.confirm).toBeUndefined();
		expect(step.view.quit).toBe(false);
		expect(step.view.notice).toBe("Kept shop-1.");
	}
});

test("main is no worktree: d says so and asks nothing", () => {
	const step = press(["d"], initialView("shop"));
	expect(step.view.confirm).toBeUndefined();
	expect(step.intent).toBeUndefined();
	expect(step.view.notice).toBe("Main is not a worktree: only a worktree is removed here.");
});

test("uncommitted changes need a second word: the worktree's name typed out, then enter, removes it with --force", () => {
	const from = initialView("shop.shop-2");
	const second = press(["d", "y"], from);
	expect(second.intent).toBeUndefined();
	expect(second.view.confirm).toEqual({
		namespace: "shop.shop-2",
		suffix: "shop-2",
		step: "discard",
		typed: "",
	});
	const typed = press(["d", "y", ..."shop-2", "return"], from);
	expect(typed.intent).toEqual({
		kind: "remove",
		suffix: "shop-2",
		namespace: "shop.shop-2",
		force: true,
	});
	expect(typed.view.confirm).toBeUndefined();
	// Typing goes to the name: y, q and d are letters, not keys; backspace takes one back.
	expect(press(["d", "y", "s", "q", "backspace"], from).view.confirm?.typed).toBe("s");
});

test("the worktree's name pasted is typed: enter then removes it", () => {
	const from = initialView("shop.shop-2");
	const pasted = press(["d", "y", { paste: "shop-2" }], from);
	expect(pasted.view.confirm?.typed).toBe("shop-2");
	expect(press(["d", "y", { paste: "shop-2" }, "return"], from).intent).toEqual({
		kind: "remove",
		suffix: "shop-2",
		namespace: "shop.shop-2",
		force: true,
	});
	// Asked y or n, a paste is no answer: the question stays.
	expect(press(["d", { paste: "yes" }], from).view.confirm?.step).toBe("remove");
});

test("a second y, a wrong name or escape keeps a worktree with uncommitted changes", () => {
	const from = initialView("shop.shop-2");
	for (const keys of [
		["d", "y", "y", "return"],
		["d", "y", ..."shop-1", "return"],
		["d", "y", ..."shop-", "return"],
		["d", "y", "return"],
		["d", "y", ..."shop-2", "escape"],
	]) {
		const step = press(keys, from);
		expect(step.intent).toBeUndefined();
		expect(step.view.confirm).toBeUndefined();
		expect(step.view.notice).toMatch(/^Kept shop-2/);
	}
	expect(press(["d", "y", "y", "return"], from).view.notice).toBe(
		"Kept shop-2: the name typed was not shop-2.",
	);
});

test("a worktree that gains changes while its removal is asked needs the second word too", () => {
	const asked = press(["d"]).view;
	const dirty: Snapshot = {
		...snapshot,
		environments: snapshot.environments.map((e) =>
			e.namespace === "shop.shop-1" ? { ...e, changes: true } : e,
		),
	};
	const step = reduce(asked, "y", dirty);
	expect(step.intent).toBeUndefined();
	expect(step.view.confirm?.step).toBe("discard");
});

test("a worktree gone while its removal is asked removes nothing", () => {
	const asked = press(["d"]).view;
	const gone: Snapshot = {
		...snapshot,
		environments: snapshot.environments.filter((e) => e.namespace !== "shop.shop-1"),
	};
	const step = reduce(asked, "y", gone);
	expect(step.intent).toBeUndefined();
	expect(step.view.confirm).toBeUndefined();
});

test("ctrl-c while asked closes the view and removes nothing", () => {
	const step = press(["d", "ctrl-c"]);
	expect(step.intent).toBeUndefined();
	expect(step.view.quit).toBe(true);
	expect(press(["d", "y", "ctrl-c"], initialView("shop.shop-2")).intent).toBeUndefined();
});

test("a adds a worktree; while one is being added, a says so rather than add a second", () => {
	expect(press(["a"]).intent).toEqual({ kind: "add" });
	const adding: Snapshot = { ...snapshot, work: [{ kind: "add", title: "Adding a worktree" }] };
	const step = press(["a"], initialView("shop"), adding);
	expect(step.intent).toBeUndefined();
	expect(step.view.notice).toBe("A worktree is being added; a adds another once it is made.");
});

test("d on a worktree being removed says so and asks nothing", () => {
	const removing: Snapshot = {
		...snapshot,
		work: [{ kind: "remove", title: "Removing shop-1", namespace: "shop.shop-1" }],
	};
	const step = press(["d"], initialView("shop.shop-1"), removing);
	expect(step.view.confirm).toBeUndefined();
	expect(step.view.notice).toBe("shop-1 is being removed.");
});

test("while a worktree is added or removed, q and ctrl-c close at once: the work goes on without the view", () => {
	const busy: Snapshot = {
		...snapshot,
		work: [{ kind: "remove", title: "Removing shop-1", namespace: "shop.shop-1" }],
	};
	expect(press(["q"], initialView("shop"), busy).view.quit).toBe(true);
	expect(press(["ctrl-c"], initialView("shop"), busy).view.quit).toBe(true);
});
