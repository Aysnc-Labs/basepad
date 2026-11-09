import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

/** A small monorepo: three projects, a shared package, and a lockfile every project depends on. */
const CONFIG = [
	"[ci]",
	'all = ["pnpm-lock.yaml"]',
	"",
	"[ci.projects.web]",
	'paths = ["apps/web", "packages/ui/**"]',
	'run = "echo web >> ran.txt"',
	"",
	"[ci.projects.docs]",
	'paths = ["docs/**/*.md"]',
	'run = ["echo docs-build >> ran.txt", "echo docs-test >> ran.txt"]',
	"",
	"[ci.projects.api]",
	'paths = ["apps/api"]',
	'run = "echo api >> ran.txt && exit 3"',
	"",
].join("\n");

const FILES = {
	"basepad.toml": CONFIG,
	".gitignore": "ran.txt\n",
	"pnpm-lock.yaml": "lockfileVersion: 9\n",
	"apps/web/page.ts": "export {};\n",
	"apps/api/server.ts": "export {};\n",
	"packages/ui/button.ts": "export {};\n",
	"docs/guide/intro.md": "# Intro\n",
	"docs/logo.svg": "<svg/>\n",
	"README.md": "# Repo\n",
};

let box: Sandbox;
let repo: string;
let counter = 0;

beforeAll(async () => {
	box = await sandbox();
});
afterAll(async () => {
	await box?.dispose();
});
beforeEach(async () => {
	repo = await box.repo(`repo-${++counter}`);
	for (const [path, content] of Object.entries(FILES)) await put(path, content);
	await commit("Projects");
	await git("switch", "--quiet", "-c", "feat");
});

async function put(path: string, content = "changed\n"): Promise<void> {
	await mkdir(dirname(join(repo, path)), { recursive: true });
	await writeFile(join(repo, path), content);
}
async function git(...args: string[]): Promise<string> {
	const out = await box.git(repo, ...args);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}
async function commit(message: string): Promise<string> {
	await git("add", "--all");
	await git("commit", "--quiet", "--message", message);
	return git("rev-parse", "HEAD");
}
const lines = (text: string) => text.split("\n").filter(Boolean);

/** `basepad changed`, as CI's runner would call it: in GitHub Actions, given the event. */
async function changed(event?: { name: string; payload: unknown }, cwd = repo) {
	if (!event) return box.basepad(cwd, "changed");
	const file = join(box.root, `event-${++counter}.json`);
	await writeFile(file, JSON.stringify(event.payload));
	return box.basepadWith(
		{ env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event.name, GITHUB_EVENT_PATH: file } },
		cwd,
		"changed",
	);
}

describe("basepad changed", () => {
	test("lists the projects whose paths a branch's commits touch, against its merge-base with main", async () => {
		await put("packages/ui/button.ts");
		await commit("Restyle the button");
		// main moves on after the branch was cut: its own changes are not the branch's.
		await git("switch", "--quiet", "main");
		await put("apps/api/server.ts");
		await commit("Main's own change");
		await git("switch", "--quiet", "feat");

		const out = await changed();
		expect(out.code).toBe(0);
		expect(lines(out.stdout)).toEqual(["web"]);
		expect(out.stderr).toContain("main");
	});

	test("counts uncommitted and untracked files, and lists projects in the config's order", async () => {
		await put("docs/guide/new-page.md");
		await put("apps/web/page.ts");
		expect(lines((await changed()).stdout)).toEqual(["web", "docs"]);
	});

	test("matches globs: a file outside every project's paths selects nothing", async () => {
		await put("docs/logo.svg");
		await put("README.md");
		const out = await changed();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("");
	});

	test("a file moved out of a project selects that project", async () => {
		await mkdir(join(repo, "lib"));
		await rename(join(repo, "apps/api/server.ts"), join(repo, "lib/server.ts"));
		await commit("Move the server");
		expect(lines((await changed()).stdout)).toEqual(["api"]);
	});

	test("a path in `all` selects every project", async () => {
		await put("pnpm-lock.yaml");
		await commit("Bump");
		expect(lines((await changed()).stdout)).toEqual(["web", "docs", "api"]);
	});

	test("prefers origin's main to a local main", async () => {
		const clone = join(box.root, `clone-${++counter}`);
		await git("switch", "--quiet", "main"); // origin's default branch, as a host's would be
		expect((await box.git(box.root, "clone", "--quiet", repo, clone)).code).toBe(0);
		// The clone's local main gains a docs commit that origin doesn't have.
		await box.git(clone, "switch", "--quiet", "main");
		await writeFile(join(clone, "docs/guide/intro.md"), "local only\n");
		await box.git(clone, "commit", "--quiet", "--all", "--message", "Unpushed");
		await box.git(clone, "switch", "--quiet", "-c", "topic");
		const out = await changed(undefined, clone);
		expect(out.stderr).toContain("origin/main");
		expect(lines(out.stdout)).toEqual(["docs"]);
	});

	test("in a pull request, compares with the PR's base", async () => {
		const base = await git("rev-parse", "HEAD");
		await put("apps/web/page.ts");
		await commit("One");
		await put("docs/guide/intro.md");
		await commit("Two");
		const out = await changed({
			name: "pull_request",
			payload: { pull_request: { base: { sha: base }, head: { sha: "unused" } } },
		});
		expect(out.code).toBe(0);
		expect(lines(out.stdout)).toEqual(["web", "docs"]);
		expect(out.stderr).toContain(base.slice(0, 7));
	});

	test("on a push, compares with the commit the branch was at before it", async () => {
		await put("apps/web/page.ts");
		const before = await commit("Pushed earlier");
		await put("docs/guide/intro.md");
		await commit("Pushed now");
		const out = await changed({ name: "push", payload: { before } });
		expect(lines(out.stdout)).toEqual(["docs"]);
	});

	test("on a new branch's first push, falls back to the merge-base with main", async () => {
		await put("apps/api/server.ts");
		await commit("First");
		const out = await changed({ name: "push", payload: { before: "0".repeat(40) } });
		expect(lines(out.stdout)).toEqual(["api"]);
	});

	test("selects every project, and says why, when the base isn't in the clone", async () => {
		await put("README.md");
		await commit("Docs only");
		const out = await changed({ name: "push", payload: { before: "1".repeat(40) } });
		expect(out.code).toBe(0);
		expect(lines(out.stdout)).toEqual(["web", "docs", "api"]);
		expect(out.stderr).toMatch(/fetch-depth/);
	});

	test("says what to add when the repo has no [ci] rules", async () => {
		await writeFile(join(repo, "basepad.toml"), "[services.postgres]\n");
		const out = await changed();
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("[ci.projects.");
	});
});

describe("basepad ci", () => {
	const ran = async () => lines(await readFile(join(repo, "ran.txt"), "utf8").catch(() => ""));

	test("runs the changed projects' commands from the repo's root, in order", async () => {
		await put("packages/ui/button.ts");
		await put("docs/guide/intro.md");
		await mkdir(join(repo, "apps/web/deep"), { recursive: true });
		const out = await box.basepad(join(repo, "apps/web/deep"), "ci");
		expect(out.stderr).toContain("web");
		expect(out.code).toBe(0);
		expect(await ran()).toEqual(["web", "docs-build", "docs-test"]);
	});

	test("runs every selected project even when one fails, then fails itself", async () => {
		await put("pnpm-lock.yaml");
		const out = await box.basepad(repo, "ci");
		expect(out.code).toBe(1);
		expect(await ran()).toEqual(["web", "docs-build", "docs-test", "api"]);
		expect(out.stderr).toMatch(/api.*exit 3/);
	});

	test("runs the named projects, or every project with --all", async () => {
		expect((await box.basepad(repo, "ci", "docs")).code).toBe(0);
		expect(await ran()).toEqual(["docs-build", "docs-test"]);
		await rm(join(repo, "ran.txt"));
		expect((await box.basepad(repo, "ci", "--all")).code).toBe(1);
		expect(await ran()).toEqual(["web", "docs-build", "docs-test", "api"]);
		const unknown = await box.basepad(repo, "ci", "mobile");
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("mobile");
	});

	test("does nothing, and succeeds, when no project changed", async () => {
		const out = await box.basepad(repo, "ci");
		expect(out.code).toBe(0);
		expect(await ran()).toEqual([]);
		expect(out.stderr).toContain("No project");
	});
});
