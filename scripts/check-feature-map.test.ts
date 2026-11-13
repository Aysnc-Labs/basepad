import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { checkFeatureMap } from "./check-feature-map.ts";

const roots: string[] = [];
const coverage = [
	{ dir: "src", include: "directories" },
	{ dir: "scripts", include: "files" },
] as const;

// A git repository with one module, one script and its test, and an ADR, plus the given map, all tracked.
function fixture(map: string): string {
	const root = mkdtempSync(join(tmpdir(), "feature-map-"));
	roots.push(root);
	const files = [
		"src/search/index.ts",
		"scripts/build.ts",
		"scripts/build.test.ts",
		"docs/adr/0001-a.md",
	];
	for (const file of files) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), "");
	}
	writeFileSync(join(root, "docs/feature-map.md"), map);
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "--all"], { cwd: root });
	return root;
}

const validMap = `# Feature map

<!--
Paths: src/not-checked/
-->

### Search
Purpose: find a document by its words.
Entry: the \`search\` command
Paths: src/search/, scripts/build.ts
Decisions: [0001](adr/0001-a.md)
`;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a valid map passes, ignoring guidance comments", () => {
	const { errors, summary } = checkFeatureMap(fixture(validMap), coverage);
	assert.deepEqual(errors, []);
	assert.equal(summary, "feature map: 1 features, 2 paths, 1 links, 2 modules covered");
});

test("an entry without a Purpose line fails", () => {
	const map = validMap.replace("Purpose: find a document by its words.\n", "");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		'docs/feature-map.md:7 feature "Search" has no Purpose: line',
	]);
});

test("an entry without an Entry line fails", () => {
	const map = validMap.replace("Entry: the `search` command\n", "");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		'docs/feature-map.md:7 feature "Search" has no Entry: line',
	]);
});

test("an entry without a Paths line fails, and its modules go uncovered", () => {
	const map = validMap.replace("Paths: src/search/, scripts/build.ts\n", "");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		'docs/feature-map.md:7 feature "Search" has no Paths: line',
		"uncovered module: src/search (list it under a feature in docs/feature-map.md)",
		"uncovered module: scripts/build.ts (list it under a feature in docs/feature-map.md)",
	]);
});

test("an entry with two Entry lines fails", () => {
	const map = validMap.replace(
		"Paths: src/search/,",
		"Entry: the `find` command\nPaths: src/search/,",
	);
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		'docs/feature-map.md:10 feature "Search" has a second Entry: line',
	]);
});

test("an entry with two Paths lines fails", () => {
	const map = validMap.replace("Decisions:", "Paths: src/search/\nDecisions:");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		'docs/feature-map.md:11 feature "Search" has a second Paths: line',
	]);
});

test("an entry with two Purpose lines fails", () => {
	const map = validMap.replace("Entry:", "Purpose: and another.\nEntry:");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		'docs/feature-map.md:9 feature "Search" has a second Purpose: line',
	]);
});

test("a listed path that does not exist fails", () => {
	const map = validMap.replace("src/search/,", "src/search/, src/gone/,");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		"docs/feature-map.md:10 path does not exist: src/gone/",
	]);
});

test("a link that does not resolve fails", () => {
	const map = validMap.replace("0001-a.md", "0002-missing.md");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		"docs/feature-map.md:11 link does not resolve: adr/0002-missing.md",
	]);
});

test("a module no feature lists fails", () => {
	const map = validMap.replace("Paths: src/search/, scripts/build.ts", "Paths: src/search/");
	assert.deepEqual(checkFeatureMap(fixture(map), coverage).errors, [
		"uncovered module: scripts/build.ts (list it under a feature in docs/feature-map.md)",
	]);
});

test("untracked files under a coverage root are not modules", () => {
	const root = fixture(validMap);
	for (const file of ["src/.DS_Store", "src/scratch/notes.ts", "scripts/tmp.ts"]) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), "");
	}
	assert.deepEqual(checkFeatureMap(root, coverage).errors, []);
});

test("a missing map names the fix", () => {
	const root = fixture("");
	rmSync(join(root, "docs/feature-map.md"));
	assert.match(checkFeatureMap(root, coverage).errors[0] ?? "", /run \/aysnc-skills:setup/);
});
