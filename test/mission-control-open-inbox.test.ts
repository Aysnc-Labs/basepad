import { expect, test } from "vitest";
import {
	initialView,
	type Press,
	reduce,
	type Snapshot,
	type View,
} from "../src/mission-control/model.ts";

/** A service with a domain of its own, such as Mailpit's inbox, has a page `o` can open. */

const snapshot: Snapshot = {
	project: "shop",
	environments: [
		{
			namespace: "shop",
			label: "main",
			dir: "/code/shop",
			apps: [
				{ id: "shop/web", name: "web", state: "running", address: "https://web.shop.localhost" },
			],
			services: [
				{
					id: "shop/db",
					name: "db",
					state: "running",
					address: "postgresql://postgres@127.0.0.1:15432/shop_db",
					note: "postgres",
				},
				{
					id: "shop/mail",
					name: "mail",
					state: "running",
					address: "https://mail.shop.localhost",
					note: "mailpit",
				},
			],
		},
	],
	logs: new Map(),
	rate: 0,
};

function press(keys: Press[]) {
	let step = { view: initialView("shop") } as { view: View; intent?: unknown };
	for (const key of keys) step = reduce(step.view, key, snapshot);
	return step;
}

test("o on Mailpit opens its inbox", () => {
	// web, db, mail
	expect(press(["right", "right", "right", "o"]).intent).toEqual({
		kind: "open",
		url: "https://mail.shop.localhost",
	});
});

test("o on Postgres still has no page to open", () => {
	const step = press(["right", "right", "o"]);
	expect(step.intent).toBeUndefined();
	expect(step.view.notice).toContain("no page to open");
});
