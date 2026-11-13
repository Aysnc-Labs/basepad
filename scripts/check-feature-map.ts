// Verifies docs/feature-map.md against the repository: every feature has exactly one Purpose, Entry
// and Paths line, every listed path exists, every relative link resolves, and every module under the
// coverage roots is listed by some feature. Modules come from git-tracked files, so untracked or
// ignored files never count. Run: node scripts/check-feature-map.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAP_FILE = "docs/feature-map.md";

type CoverageRoot = { dir: string; include: "directories" | "files" };

// Each child of a root is a module that some feature must list. `directories` counts child
// directories; `files` also counts child files (test files excepted). A child that is itself a
// root is not a module.
// ---- PER-PROJECT: setup sets these roots from the project layout. ----
export const COVERAGE_ROOTS: readonly CoverageRoot[] = [
	{ dir: "src", include: "files" },
	{ dir: "src/catalogue", include: "files" },
	{ dir: "src/internal", include: "files" },
];
// ---- END PER-PROJECT ----

const PATH_LINE = /^Paths:\s*(.+)$/;
const REQUIRED_LABELS = ["Purpose", "Entry", "Paths"] as const;
const FEATURE_HEADING = /^### (.+)$/;
const LINK = /\]\(([^)\s]+)\)/g;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

export type Result = { errors: string[]; summary: string };

const trimSlash = (path: string) => path.replace(/\/+$/, "");

// Lines outside fenced code blocks and HTML comments: diagrams and guidance hold labels, not paths.
function proseLines(markdown: string): { text: string; line: number }[] {
	const lines: { text: string; line: number }[] = [];
	let fenced = false;
	let comment = false;
	markdown.split("\n").forEach((text, index) => {
		if (text.trimStart().startsWith("```")) {
			fenced = !fenced;
			return;
		}
		if (!fenced && text.includes("<!--")) comment = true;
		if (!fenced && !comment) lines.push({ text, line: index + 1 });
		if (comment && text.includes("-->")) comment = false;
	});
	return lines;
}

function trackedFiles(root: string): string[] {
	return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((file) => file !== "" && existsSync(join(root, file)));
}

function modulesOf(
	files: string[],
	roots: readonly CoverageRoot[],
	coverageRoot: CoverageRoot,
): string[] {
	const rootDirs = new Set(roots.map((entry) => entry.dir));
	const prefix = `${coverageRoot.dir}/`;
	const modules = new Set<string>();
	for (const file of files) {
		if (!file.startsWith(prefix)) continue;
		const [name = "", ...rest] = file.slice(prefix.length).split("/");
		const isDirectory = rest.length > 0;
		if (!isDirectory && (coverageRoot.include !== "files" || TEST_FILE.test(name))) continue;
		modules.add(posix.join(coverageRoot.dir, name));
	}
	return [...modules].filter((module) => !rootDirs.has(module)).sort();
}

// Each "### " feature holds exactly one line per required label.
function checkEntries(lines: { text: string; line: number }[]): string[] {
	const errors: string[] = [];
	let feature: { name: string; line: number; seen: Set<string> } | undefined;
	const close = () => {
		for (const label of REQUIRED_LABELS) {
			if (feature && !feature.seen.has(label))
				errors.push(`${MAP_FILE}:${feature.line} feature "${feature.name}" has no ${label}: line`);
		}
	};
	for (const { text, line } of lines) {
		const heading = FEATURE_HEADING.exec(text);
		if (heading || text.startsWith("## ")) {
			close();
			feature = heading ? { name: (heading[1] ?? "").trim(), line, seen: new Set() } : undefined;
			continue;
		}
		const label = REQUIRED_LABELS.find((name) => text.startsWith(`${name}:`));
		if (!feature || !label) continue;
		if (feature.seen.has(label))
			errors.push(`${MAP_FILE}:${line} feature "${feature.name}" has a second ${label}: line`);
		feature.seen.add(label);
	}
	close();
	return errors;
}

export function checkFeatureMap(
	root: string,
	roots: readonly CoverageRoot[] = COVERAGE_ROOTS,
): Result {
	const errors: string[] = [];
	const mapPath = join(root, MAP_FILE);
	if (!existsSync(mapPath))
		return { errors: [`${MAP_FILE} not found: run /aysnc-skills:setup`], summary: "" };

	const lines = proseLines(readFileSync(mapPath, "utf8"));
	errors.push(...checkEntries(lines));
	const listed: string[] = [];
	let links = 0;

	for (const { text, line } of lines) {
		const pathLine = PATH_LINE.exec(text);
		for (const raw of pathLine?.[1]?.split(",") ?? []) {
			const path = raw.trim();
			if (!path) continue;
			listed.push(trimSlash(path));
			const absolute = join(root, path);
			if (!existsSync(absolute)) errors.push(`${MAP_FILE}:${line} path does not exist: ${path}`);
			else if (path.endsWith("/") && !statSync(absolute).isDirectory())
				errors.push(`${MAP_FILE}:${line} not a directory: ${path}`);
		}
		for (const match of text.matchAll(LINK)) {
			const target = match[1] ?? "";
			if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
			links++;
			const file = target.split("#")[0] ?? "";
			if (!existsSync(resolve(join(root, dirname(MAP_FILE)), file)))
				errors.push(`${MAP_FILE}:${line} link does not resolve: ${target}`);
		}
	}

	const files = trackedFiles(root);
	const modules = roots.flatMap((coverageRoot) => modulesOf(files, roots, coverageRoot));
	for (const module of modules) {
		const covered = listed.some(
			(path) => path === module || path.startsWith(`${module}/`) || module.startsWith(`${path}/`),
		);
		if (!covered)
			errors.push(`uncovered module: ${module} (list it under a feature in ${MAP_FILE})`);
	}

	const features = lines.filter(({ text }) => text.startsWith("### ")).length;
	return {
		errors,
		summary: `feature map: ${features} features, ${listed.length} paths, ${links} links, ${modules.length} modules covered`,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const { errors, summary } = checkFeatureMap(root);
	if (errors.length > 0) {
		console.error(
			`feature map check failed (${errors.length}):\n${errors.map((error) => `  - ${error}`).join("\n")}`,
		);
		process.exit(1);
	}
	console.log(summary);
}
