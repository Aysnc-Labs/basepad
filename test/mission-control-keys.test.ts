import type { Key } from "ink";
import { expect, test } from "vitest";
import { initialView, reduce, type Snapshot } from "../src/mission-control/model.ts";
import { pressOf } from "../src/mission-control/run.ts";

const part = (id: string) => ({
	id,
	name: id.split("/")[1] as string,
	state: "running" as const,
	address: "",
});
const env = (namespace: string, apps: string[], services: string[] = []) => ({
	namespace,
	label: namespace.split(".")[1] ?? "main",
	dir: `/code/${namespace}`,
	apps: apps.map((name) => part(`${namespace}/${name}`)),
	services: services.map((name) => part(`shop/${name}`)),
});
const snapshot: Snapshot = {
	project: "shop",
	environments: [
		env("shop", ["web", "api"], ["db"]),
		env("shop.worktree-1", ["web", "api"], ["db"]),
		env("shop.worktree-2", ["web"]),
	],
	logs: new Map(),
	rate: 0,
};

const press = (keys: string[], from = initialView("shop")) =>
	keys.reduce((view, key) => reduce(view, key, snapshot).view, from);

test("tab and shift-tab select the next and previous environment, round again; left and right too", () => {
	expect(press(["tab"]).selected).toBe("shop.worktree-1");
	expect(press(["tab", "tab", "tab"]).selected).toBe("shop");
	expect(press(["shift-tab"]).selected).toBe("shop.worktree-2");
	expect(press(["right", "right", "left"]).selected).toBe("shop.worktree-1");
});

test("a number selects the environment the sidebar numbers with it", () => {
	expect(press(["3"]).selected).toBe("shop.worktree-2");
	expect(press(["3", "1"]).selected).toBe("shop");
	expect(press(["2", "9"]).selected).toBe("shop.worktree-1");
});

test("down steps from all through each app and service, stopping at the last; up goes back to all", () => {
	expect(press(["down"]).focus).toBe("shop/web");
	expect(press(["down", "down", "down"]).focus).toBe("shop/db");
	expect(press(["down", "down", "down", "down"]).focus).toBe("shop/db");
	expect(press(["down", "up"]).focus).toBeUndefined();
	expect(press(["up"]).focus).toBeUndefined();
	expect(press(["j", "j", "k"]).focus).toBe("shop/web");
});

test("escape shows all again, and changing environment does too", () => {
	expect(press(["down", "escape"]).focus).toBeUndefined();
	expect(press(["down", "tab"]).focus).toBeUndefined();
});

test("q and ctrl-c quit", () => {
	expect(press(["q"]).quit).toBe(true);
	expect(press(["ctrl-c"]).quit).toBe(true);
	expect(press(["x"]).quit).toBe(false);
});

test("a selected environment that is gone moves from the first", () => {
	expect(press(["tab"], initialView("shop.worktree-9")).selected).toBe("shop.worktree-1");
});

test("text that arrives at once is a paste, a newline in it too; a character or a named key is a press", () => {
	// Ink names a key by its flags; a paste is all its text in one input, with no flag set.
	const key = (flags: Partial<Key> = {}) => flags as Key;
	expect(pressOf("worktree-2\r", key())).toEqual({ paste: "worktree-2\r" });
	expect(pressOf("d", key())).toBe("d");
	expect(pressOf("\r", key({ return: true }))).toBe("return");
	expect(pressOf("c", key({ ctrl: true }))).toBe("ctrl-c");
	expect(pressOf("\t", key({ tab: true }))).toBe("tab");
	expect(pressOf("", key({ tab: true, shift: true }))).toBe("shift-tab");
	expect(pressOf(" ", key())).toBe("space");
});
