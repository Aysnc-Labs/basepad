import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { renderToString } from "ink";
import { afterEach, expect, test } from "vitest";
import type { Colors } from "../src/mission-control/frame.ts";
import { type LandingInput, landingFrame } from "../src/mission-control/launch.ts";

const level = chalk.level;
afterEach(() => {
	chalk.level = level;
});

function draw(over: Partial<LandingInput> = {}, color: Colors = "none") {
	const cols = over.cols ?? 100;
	if (color === "rgb") chalk.level = 3;
	const text = renderToString(
		landingFrame({
			project: "alif",
			environment: "main",
			parts: ["web", "mail", "db"],
			state: "stopping",
			tick: 0,
			drop: 0,
			cols,
			color,
			...over,
		}),
		{ columns: cols },
	);
	return stripVTControlCharacters(text);
}

const PIXELS = /[▀▄]/;

test("while it stops, each app and service is listed as on its way down", () => {
	const out = draw();
	expect(out).toContain("BASEPAD  │  SPLASHDOWN");
	expect(out).toContain("ALIF  ·  MAIN");
	for (const part of ["web", "mail", "db"])
		expect(out).toMatch(new RegExp(`^ *${part}\\.+ ·· *$`, "m"));
	expect(out).toContain("DESCENT");
});

test("once stopped, each is safe, and up relaunches", () => {
	const out = draw({ state: "stopped" });
	for (const part of ["web", "mail", "db"])
		expect(out).toMatch(new RegExp(`^ *${part}\\.+ SAFE *$`, "m"));
	expect(out).toContain("SPLASHDOWN  ·  all stopped");
	expect(out).toContain("`basepad up` relaunches");
});

test("a worktree's landing says its services are main's and keep running", () => {
	const out = draw({ environment: "worktree-1", parts: ["web"], state: "stopped" });
	expect(out).toContain("ALIF  ·  WORKTREE-1");
	expect(out).toContain("Its services are main's and keep running.");
});

test("a stop that fails is no-go", () => {
	const out = draw({ state: "failed" });
	expect(out).toMatch(/^ *web\.+ NO-GO *$/m);
	expect(out).toContain("NO-GO");
	expect(out).not.toContain("SPLASHDOWN  ·");
});

test("in colour the capsule comes down beside the checklist; without, only the checklist", () => {
	const high = draw({}, "rgb");
	expect(high).toMatch(PIXELS);
	expect(draw({ drop: 10 }, "rgb")).not.toBe(high);
	expect(draw()).not.toMatch(PIXELS);
	expect(draw({ cols: 60 }, "rgb")).not.toMatch(PIXELS);
});
