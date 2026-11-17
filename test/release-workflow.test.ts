import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("the release workflow restores no cache, which a pull request could have poisoned", async () => {
	const workflow = await readFile(
		join(import.meta.dirname, "../.github/workflows/release.yml"),
		"utf8",
	);
	const steps = workflow.split(/\n\s*- /).filter((step) => step.startsWith("uses: "));
	const cached = steps.filter(
		(step) =>
			/^uses: (jdx\/mise-action|actions\/cache|actions\/setup-node)@/.test(step) &&
			!/\n\s+cache: false\b/.test(step),
	);
	expect(steps.length).toBeGreaterThan(0);
	expect(cached).toEqual([]);
});
