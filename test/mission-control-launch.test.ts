import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { afterEach, expect, test } from "vitest";
import type { Colors } from "../src/mission-control/frame.ts";
import { type Check, launchFrame } from "../src/mission-control/launch.ts";

const level = chalk.level;
afterEach(() => {
	chalk.level = level;
});

const checks = (...states: Check["state"][]): Check[] =>
	["SUPERVISOR", "SERVICE  db", "ENV FILES", "APPS  web · api"].map((name, i) => ({
		name,
		state: states[i] ?? "waiting",
	}));

function draw(over: Partial<Parameters<typeof launchFrame>[0]> = {}, color: Colors = "none") {
	const cols = over.cols ?? 100;
	if (color === "rgb") chalk.level = 3;
	const text = renderToString(
		launchFrame({
			title: "SETUP",
			subtitle: "this mac",
			checks: checks(),
			tick: 0,
			lift: 0,
			elapsed: 3,
			cols,
			color,
			...over,
		}),
		{ columns: cols },
	);
	return stripVTControlCharacters(text);
}

const PIXELS = /[▀▄]/;

test("the checklist says each check's state in words, under its title, with the time", () => {
	const out = draw({ checks: checks("go", "go", "active") });
	expect(out).toContain("BASEPAD  │  SETUP");
	expect(out).toContain("THIS MAC");
	expect(out).toMatch(/SUPERVISOR\.+ GO *$/m);
	expect(out).toMatch(/SERVICE {2}db\.+ GO *$/m);
	expect(out).toMatch(/ENV FILES\.+ ·· *$/m);
	expect(out).toMatch(/^ *APPS {2}web · api *$/m);
	expect(out).toContain("T+00:00:03");
	expect(out).toContain("PRE-LAUNCH CHECKS");
});

test("all checks go: all systems go, then lift-off once the rocket leaves", () => {
	const all = checks("go", "go", "go", "go");
	expect(draw({ checks: all })).toContain("ALL SYSTEMS GO");
	expect(draw({ checks: all, lift: 4 })).toContain("LIFT-OFF");
});

test("a failed check is no-go, by name", () => {
	const out = draw({ checks: checks("go", "nogo") });
	expect(out).toMatch(/SERVICE {2}db\.+ NO-GO *$/m);
	expect(out).toContain("NO-GO  ·  SERVICE  db");
	expect(out).not.toContain("PRE-LAUNCH CHECKS");
});

test("in colour the rocket stands beside the checklist, and rises with the lift", () => {
	const still = draw({ checks: checks("go", "go", "go", "go") }, "rgb");
	expect(still).toMatch(PIXELS);
	const rows = still.split("\n");
	const at = rows.findIndex((row) => row.includes("SUPERVISOR"));
	expect((rows[at] as string).indexOf("SUPERVISOR")).toBeGreaterThan(20);
	const lifted = draw({ checks: checks("go", "go", "go", "go"), lift: 8 }, "rgb");
	expect(lifted).not.toBe(still);
});

test("without colour, or in a narrow terminal, only the checklist shows", () => {
	expect(draw()).not.toMatch(PIXELS);
	const narrow = draw({ cols: 60 }, "rgb");
	expect(narrow).not.toMatch(PIXELS);
	expect(narrow).toContain("SUPERVISOR");
});

test("without a time, the status stands alone", () => {
	const out = draw({ elapsed: undefined, checks: checks("go", "go", "go", "go") });
	expect(out).not.toContain("T+");
	expect(out).toMatch(/^ *ALL SYSTEMS GO *$/m);
});
