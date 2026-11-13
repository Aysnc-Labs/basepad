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

test("down and up select the next and previous environment, stopping at the ends", () => {
	expect(press(["down"]).selected).toBe("shop.worktree-1");
	expect(press(["down", "down", "down"]).selected).toBe("shop.worktree-2");
	expect(press(["j", "k", "up"]).selected).toBe("shop");
});

test("right steps from all through each app and service, then back to all; left goes back", () => {
	expect(press(["right"]).focus).toBe("shop/web");
	expect(press(["right", "right", "right"]).focus).toBe("shop/db");
	expect(press(["right", "right", "right", "right"]).focus).toBeUndefined();
	expect(press(["left"]).focus).toBe("shop/db");
	expect(press(["l", "l", "h"]).focus).toBe("shop/web");
});

test("escape shows all again, and changing environment does too", () => {
	expect(press(["right", "escape"]).focus).toBeUndefined();
	expect(press(["right", "down"]).focus).toBeUndefined();
});

test("q and ctrl-c quit", () => {
	expect(press(["q"]).quit).toBe(true);
	expect(press(["ctrl-c"]).quit).toBe(true);
	expect(press(["x"]).quit).toBe(false);
});

test("a selected environment that is gone moves from the first", () => {
	expect(press(["down"], initialView("shop.worktree-9")).selected).toBe("shop.worktree-1");
});

test("text that arrives at once is a paste, a newline in it too; a character or a named key is a press", () => {
	// Ink names a key by its flags; a paste is all its text in one input, with no flag set.
	const key = (flags: Partial<Key> = {}) => flags as Key;
	expect(pressOf("worktree-2\r", key())).toEqual({ paste: "worktree-2\r" });
	expect(pressOf("d", key())).toBe("d");
	expect(pressOf("\r", key({ return: true }))).toBe("return");
	expect(pressOf("c", key({ ctrl: true }))).toBe("ctrl-c");
});
