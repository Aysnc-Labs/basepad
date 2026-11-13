import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const echo = join(import.meta.dirname, "apps/echo.mjs");
const node = (script: string) => `exec '${process.execPath}' '${script}'`;

const config = (services: string, env: string) =>
	configFile(`{
	name: "t18shop",
	services: { ${services} },
	apps: { web: { run: ${JSON.stringify(node(echo))} } },
	env: ({ ${env}, web }) => ({ ".env.local": { WEB_URL: web.url, ${env
		.split(", ")
		.map((key) => `${key.toUpperCase()}_URL: ${key}.url`)
		.join(", ")} } }),
}`);
const full = config(
	`db: postgres(), ref: postgres({ worktree: "shared" }), old: postgres()`,
	"db, ref, old",
);
/** Main's config once `old` is taken out of it. */
const withoutOld = config(`db: postgres(), ref: postgres({ worktree: "shared" })`, "db, ref");

let box: Sandbox;
let main: string;
let urls: Record<string, string>;
const tree = (n: number) => join(box.root, `t18shop.worktrees/worktree-${n}`);
const url = (host: string) => `https://${host}:${box.proxyPort}`;

const git = async (cwd: string, ...args: string[]) => {
	const { stdout } = await promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	return stdout.trim();
};

async function sql(at: string, query: string): Promise<string> {
	const out = await box.psql([at], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

/** The databases on a service's server. */
const databases = async (key: string) =>
	(await sql(urls[key] as string, "select datname from pg_database order by 1")).split("\n");

/** Main's rows are all still there. */
async function mainIntact(): Promise<void> {
	for (const key of ["db", "ref"]) {
		expect(await sql(urls[key] as string, "select name from items")).toBe("from main");
	}
}

/** `basepad` on a terminal of its own, typing `input`. */
function onTerminal(cwd: string, input: string, ...args: string[]): Promise<Result> {
	const command = [process.execPath, join(import.meta.dirname, "../dist/launcher.js"), ...args]
		.map((arg) => `'${arg}'`)
		.join(" ");
	const [file, argv] =
		process.platform === "darwin"
			? ["script", ["-q", "/dev/null", "sh", "-c", `cd '${cwd}' && ${command}`]]
			: ["script", ["-qec", `cd '${cwd}' && ${command}`, "/dev/null"]];
	return new Promise((resolve) => {
		const child = execFile(file, argv, { env: box.env }, (error, stdout, stderr) =>
			resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
		);
		child.stdin?.end(input);
	});
}

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t18shop", {
		"basepad.config.ts": full,
		".gitignore": "node_modules\n.env.local\n",
	});
	await git(main, "init", "--quiet", "--initial-branch=main");
	await git(main, "add", ".");
	await git(main, "commit", "--quiet", "-m", "init");
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	const env = await readEnv(main, ".env.local");
	urls = { db: env.DB_URL as string, ref: env.REF_URL as string, old: env.OLD_URL as string };
	for (const key of ["db", "ref", "old"]) {
		await sql(
			urls[key] as string,
			"create table items (name text); insert into items values ('from main')",
		);
	}
	for (let n = 1; n <= 5; n++) {
		const out = await box.basepad(main, "worktree", "add", "--json");
		expect(out.stderr).not.toContain("basepad:");
	}
}, 600_000);
afterAll(() => box?.dispose());

test("worktree ls lists every worktree with its branch and folder", async () => {
	const out = await box.basepad(main, "worktree", "ls");
	expect(out.stderr).toBe("");
	for (let n = 1; n <= 5; n++) {
		expect(out.stdout).toMatch(new RegExp(`worktree-${n} +worktree-${n} +${tree(n)}`));
	}
});

test("status in main lists main and every worktree, with domains and databases", async () => {
	const out = await box.basepad(main, "status");
	expect(out.stderr).toBe("");
	expect(out.stdout).toContain(url("web.t18shop.localhost"));
	expect(out.stdout).toContain(`worktree-3 on branch worktree-3 at ${tree(3)}`);
	expect(out.stdout).toContain(url("web.worktree-3.t18shop.localhost"));
	expect(out.stdout).toMatch(/db +postgresql:\/\/\S+\/t18shop_db_worktree_3 +running/);
	expect(out.stdout).toMatch(/ref +postgresql:\/\/\S+\/t18shop_ref +running/);
});

test("rm refuses a worktree with uncommitted changes, and changes nothing", async () => {
	await writeFile(join(tree(2), "notes.txt"), "work in progress\n");
	const out = await box.basepad(main, "worktree", "rm", "worktree-2");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("uncommitted changes");
	expect(out.stderr).toContain("--force");
	expect(existsSync(join(tree(2), "notes.txt"))).toBe(true);
	expect(await databases("db")).toContain("t18shop_db_worktree_2");
});

test("rm --force removes it all the same", async () => {
	const out = await box.basepad(main, "worktree", "rm", "worktree-2", "--force");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(existsSync(tree(2))).toBe(false);
	expect(await databases("db")).not.toContain("t18shop_db_worktree_2");
	await mainIntact();
});

test("rm stops the worktree's apps, drops its databases, unregisters it and keeps its branch", async () => {
	const up = await box.basepad(tree(1), "up");
	expect(up.stderr).toBe("");
	expect((await box.get<{ cwd: string }>(url("web.worktree-1.t18shop.localhost"))).cwd).toBe(
		tree(1),
	);
	const out = await box.basepad(main, "worktree", "rm", "worktree-1");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(out.stdout).toContain("Removed worktree worktree-1");
	await expect(box.get(url("web.worktree-1.t18shop.localhost"))).rejects.toThrow();
	expect(existsSync(tree(1))).toBe(false);
	expect(await git(main, "worktree", "list")).not.toContain("worktree-1");
	expect(await git(main, "branch", "--list", "worktree-1")).toContain("worktree-1");
	for (const key of ["db", "old"]) {
		expect(await databases(key)).not.toContain(`t18shop_${key}_worktree_1`);
	}
	expect(existsSync(join(box.root, "home/environments/t18shop.worktree-1.toml"))).toBe(false);
	// The shared database is main's, and stays; main's app keeps answering.
	await mainIntact();
	expect((await box.get<{ cwd: string }>(url("web.t18shop.localhost"))).cwd).toBe(main);
});

test("rm works when the worktree's config is broken", async () => {
	await writeFile(join(tree(3), "basepad.config.ts"), "this is not a config {");
	await git(tree(3), "commit", "--quiet", "-am", "break it");
	const out = await box.basepad(main, "worktree", "rm", "worktree-3");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(await databases("db")).not.toContain("t18shop_db_worktree_3");
	await mainIntact();
});

test("rm works when the worktree's folder is already gone", async () => {
	await rm(tree(4), { recursive: true, force: true });
	const out = await box.basepad(main, "worktree", "rm", "worktree-4");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(await databases("db")).not.toContain("t18shop_db_worktree_4");
	expect(await git(main, "worktree", "list")).not.toContain("worktree-4");
	await mainIntact();
});

test("rm of a worktree git does not know is refused", async () => {
	const out = await box.basepad(main, "worktree", "rm", "worktree-9");
	expect(out.code).toBe(1);
	expect(out.stderr).toContain("no worktree `worktree-9`");
});

test("prune without --yes and without a terminal lists leftovers and removes nothing", async () => {
	await rm(tree(5), { recursive: true, force: true });
	await writeFile(join(main, "basepad.config.ts"), withoutOld);
	const out = await box.basepad(main, "prune");
	expect(out.code).toBe(1);
	expect(out.stdout).toContain(tree(5));
	expect(out.stdout).toContain("t18shop_db_worktree_5");
	expect(out.stdout).toContain("t18shop.worktree-5");
	expect(out.stdout).toMatch(/old +\S+services\/t18shop\/old/);
	expect(out.stderr).toContain("--yes");
	expect(await databases("db")).toContain("t18shop_db_worktree_5");
	expect(existsSync(join(box.root, "home/services/t18shop/old"))).toBe(true);
});

test("prune --yes removes the leftovers of gone worktrees, and keeps a removed service's data", async () => {
	const out = await box.basepad(main, "prune", "--yes");
	expect(out.stderr).toBe("");
	expect(out.code).toBe(0);
	expect(await databases("db")).not.toContain("t18shop_db_worktree_5");
	expect(await git(main, "worktree", "list")).not.toContain("worktree-5");
	expect(existsSync(join(box.root, "home/environments/t18shop.worktree-5.toml"))).toBe(false);
	expect(out.stdout).toContain("Kept");
	expect(existsSync(join(box.root, "home/services/t18shop/old"))).toBe(true);
	await mainIntact();
	const again = await box.basepad(main, "prune", "--yes");
	expect(again.stdout).not.toContain("Left by worktrees");
});

test("prune deletes a removed service's data only when asked on a terminal", async () => {
	const no = await onTerminal(main, "n\n", "prune");
	expect(no.code).toBe(0);
	expect(existsSync(join(box.root, "home/services/t18shop/old"))).toBe(true);
	const yes = await onTerminal(main, "y\n", "prune");
	expect(yes.stdout).toContain("Deleted");
	expect(yes.code).toBe(0);
	expect(existsSync(join(box.root, "home/services/t18shop/old"))).toBe(false);
	// No server is left running on the deleted data.
	const ps = await box.run("ps", ["-eo", "args"]);
	expect(ps.stdout).not.toContain(join(box.root, "home/services/t18shop/old"));
	await mainIntact();
	expect(await databases("db")).toContain("t18shop_db");
});
