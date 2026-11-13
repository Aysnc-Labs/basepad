import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, type Result, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

/** `db import` and `db export`: dumps in and out of the environment's own database. */

let box: Sandbox;
let main: string;
let tree: string;
const cli = join(import.meta.dirname, "../dist/launcher.js");

const git = async (cwd: string, ...args: string[]) => {
	await promisify(execFile)("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
};

/** A main checkout under git with `services`, up; `env` writes `<KEY>_URL` for each. */
async function project(name: string, services: Record<string, string>): Promise<string> {
	const keys = Object.keys(services);
	const dir = await box.project(name, {
		"basepad.config.ts": configFile(`{
	name: "${name}",
	services: { ${keys.map((key) => `${key}: ${services[key]}`).join(", ")} },
	env: ({ ${keys.join(", ")} }) => ({ ".env.local": { ${keys
		.map((key) => `${key.toUpperCase()}_URL: ${key}.url`)
		.join(", ")} } }),
}`),
		".gitignore": "node_modules\n.env.local\n*.dump\n*.sql\n",
	});
	await git(dir, "init", "--quiet", "--initial-branch=main");
	await git(dir, "add", ".");
	await git(dir, "commit", "--quiet", "-m", "init");
	const up = await box.basepad(dir, "up");
	expect(up.stderr).toBe("");
	return dir;
}

const url = async (dir: string, key = "db") =>
	(await readEnv(dir, ".env.local"))[`${key.toUpperCase()}_URL`] as string;

async function sql(dir: string, query: string, key = "db"): Promise<string> {
	const out = await box.psql([await url(dir, key)], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

/** The names in `items`, sorted; `none` when there is no such table. */
const rows = (dir: string, key = "db") =>
	sql(
		dir,
		"select case when to_regclass('items') is null then 'none' else (select coalesce(string_agg(name, ',' order by name), '') from items) end",
		key,
	);

/** `basepad` in `dir`, expected to succeed; its output. */
async function ok(dir: string, ...args: string[]): Promise<string> {
	const result = await box.basepad(dir, ...args);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	return result.stdout;
}

/**
 * `basepad` on a terminal of its own, typing `input` once it asks. Input stays open until basepad
 * exits. On macOS, Python's `pty`: macOS's `script` fails on Node's stdin, a socket there.
 */
function onTerminal(cwd: string, input: string, ...args: string[]): Promise<Result> {
	const command = [process.execPath, cli, ...args].map((arg) => `'${arg}'`).join(" ");
	const shell = `cd '${cwd}' && ${command}`;
	const [file, argv] =
		process.platform === "darwin"
			? [
					"python3",
					["-c", "import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)", "sh", "-c", shell],
				]
			: ["script", ["-qec", shell, "/dev/null"]];
	return new Promise((resolve) => {
		const child = execFile(file, argv, { env: box.env }, (error, stdout, stderr) =>
			resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
		);
		let typed = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (typed || !chunk.toString().includes("[y/N]")) return;
			typed = true;
			child.stdin?.write(input);
		});
	});
}

/** A plain SQL file in the sandbox that makes `items` hold `names`. */
async function sqlFile(name: string, ...names: string[]): Promise<string> {
	const file = join(box.root, name);
	await writeFile(
		file,
		`create table items (name text);\ninsert into items values ${names.map((n) => `('${n}')`).join(", ")};\n`,
	);
	return file;
}

/** The first bytes of `file`, as text. */
const head = async (file: string, bytes = 5) =>
	(await readFile(file)).subarray(0, bytes).toString("latin1");

beforeAll(async () => {
	box = await sandbox();
	main = await project("t27io", { db: "postgres()" });
	await sql(main, "create table items (name text); insert into items values ('a'), ('b')");
	await ok(main, "worktree", "add");
	tree = join(box.root, "t27io.worktrees/worktree-1");
	await sql(tree, "insert into items values ('tree')");
}, 300_000);
afterAll(async () => {
	await box?.dispose();
});

test("export writes a custom-format dump that import loads into another environment with the same rows", async () => {
	const file = join(box.root, "main.dump");
	expect(await ok(main, "db", "export", file)).toContain(file);
	expect(await head(file)).toBe("PGDMP");
	expect(await rows(tree)).toBe("a,b,tree");
	await ok(tree, "db", "import", file, "--yes");
	expect(await rows(tree)).toBe("a,b");
	expect(await rows(main)).toBe("a,b");
}, 120_000);

test("import of a plain SQL file replaces the database, and export to a .sql name writes plain SQL that imports", async () => {
	const file = await sqlFile("plain.sql", "p1", "p2");
	const imported = await ok(main, "db", "import", file, "--yes");
	expect(imported).toContain(`Imported the SQL file ${file} into \`db\`'s database t27io_db.`);
	expect(await rows(main)).toBe("p1,p2");

	const out = join(box.root, "main.sql");
	await ok(main, "db", "export", out);
	const text = await readFile(out, "utf8");
	expect(text.startsWith("--")).toBe(true);
	expect(text).toContain("CREATE TABLE public.items");
	expect(text).not.toMatch(/OWNER TO/);
	await sql(main, "insert into items values ('later')");
	await ok(main, "db", "import", out, "-y");
	expect(await rows(main)).toBe("p1,p2");
}, 120_000);

test("with no file, export writes a custom-format dump to standard output, and anything else to standard error", async () => {
	const file = join(box.root, "stdout.dump");
	const result = await box.run("bash", [
		"-c",
		`cd '${main}' && '${process.execPath}' '${cli}' db export > '${file}'`,
	]);
	expect(result.code).toBe(0);
	expect(await head(file)).toBe("PGDMP");
	await sql(main, "delete from items");
	await ok(main, "db", "import", file, "--yes");
	expect(await rows(main)).toBe("p1,p2");

	const onScreen = await onTerminal(main, "", "db", "export");
	expect(onScreen.code).toBe(1);
	expect(onScreen.stdout).toContain("which is a terminal here. Name a file, or redirect it");
}, 120_000);

test("import asks first, naming the database, and changes nothing unless told yes", async () => {
	const file = await sqlFile("asked.sql", "asked");
	const before = await rows(main);

	const unasked = await box.basepad(main, "db", "import", file);
	expect(unasked.code).toBe(1);
	expect(unasked.stderr).toContain(
		"Import replaces `db`'s database t27io_db, and there is no terminal to ask. Run it again with `--yes`",
	);
	expect(await rows(main)).toBe(before);

	const no = await onTerminal(main, "n\n", "db", "import", file);
	expect(no.stdout).toContain("Replace `db`'s database t27io_db? Its data is lost. [y/N]");
	expect(no.code).toBe(1);
	expect(await rows(main)).toBe(before);

	const yes = await onTerminal(main, "y\n", "db", "import", file);
	expect(yes.code).toBe(0);
	expect(await rows(main)).toBe("asked");
}, 120_000);

test("an import that fails leaves the database as it was, and nothing beside it", async () => {
	await sql(main, "insert into items values ('kept')");
	const before = await rows(main);
	const broken = join(box.root, "broken.sql");
	await writeFile(broken, "create table other (id int);\ninsert into nowhere values (1);\n");
	const result = await box.basepad(main, "db", "import", broken, "--yes");
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("`t27io_db` is as it was");
	expect(result.stderr).toContain('relation "nowhere" does not exist');
	expect(await rows(main)).toBe(before);
	expect(await sql(main, "select count(*) from pg_database where datname like '%~%'")).toBe("0");

	const missing = await box.basepad(main, "db", "import", "nope.dump", "--yes");
	expect(missing.code).toBe(1);
	expect(missing.stderr).toContain("There is no file nope.dump");
	expect(await rows(main)).toBe(before);
}, 120_000);

test("inside a worktree, import and export act on its database and leave main's unchanged", async () => {
	const mainRows = await rows(main);
	const file = await sqlFile("tree.sql", "tree-only");
	const no = await onTerminal(tree, "n\n", "db", "import", file);
	expect(no.stdout).toContain("Replace `db`'s database t27io_db_worktree_1?");
	await ok(tree, "db", "import", file, "--yes");
	expect(await rows(tree)).toBe("tree-only");
	expect(await rows(main)).toBe(mainRows);

	const out = join(box.root, "tree.dump");
	await ok(tree, "db", "export", out);
	await ok(main, "db", "save", "before");
	await ok(main, "db", "import", out, "--yes");
	expect(await rows(main)).toBe("tree-only");
	await ok(main, "db", "load", "before");
	expect(await rows(main)).toBe(mainRows);
}, 120_000);

test("import from a postgres:// URL copies that database, and with several databases only the named one", async () => {
	const other = await project("t27src", { db: "postgres()", ref: "postgres()" });
	await sql(other, "create table items (name text); insert into items values ('db-own')");
	await sql(other, "create table items (name text); insert into items values ('ref-own')", "ref");
	const source = await url(main);
	const sourceRows = await rows(main);

	const bare = await box.basepad(other, "db", "import", source, "--yes");
	expect(bare.code).toBe(1);
	expect(bare.stderr).toContain("has several databases: `db`, `ref`.");

	const copied = await ok(other, "db", "import", source, "-s", "ref", "--yes");
	expect(copied).toMatch(
		/Imported a copy of 127\.0\.0\.1:\d+\/t27io_db into `ref`'s database t27src_ref\./,
	);
	// The URL's placeholder password is never shown.
	expect(copied).not.toContain("basepad@");
	expect(await rows(other, "ref")).toBe(sourceRows);
	expect(await rows(other)).toBe("db-own");
	expect(await rows(main)).toBe(sourceRows);
}, 300_000);
