import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { configFile, readEnv, type Sandbox, sandbox } from "./sandbox.ts";

const cli = join(import.meta.dirname, "../dist/launcher.js");
const note =
	'echo "$BASEPAD_EVENT $BASEPAD_ENVIRONMENT service=$BASEPAD_SERVICE label=$BASEPAD_LABEL source=$BASEPAD_SOURCE file=$BASEPAD_FILE url=$(test -n "$DB_URL" && echo set)" >> marker';
const each = [note, "echo said by $BASEPAD_EVENT", 'test ! -e "fail-$BASEPAD_EVENT"'];
const names = ["Save", "Load", "Delete", "Import", "Export"].flatMap((event) => [
	`before${event}`,
	`after${event}`,
]);
const config = configFile(`{
	name: "t63dbhooks",
	services: { db: postgres() },
	env: ({ db }) => ({ ".env.local": { DB_URL: db.url } }),
	hooks: { ${names.map((name) => `${name}: ${JSON.stringify(each)}`).join(", ")} },
}`);

let box: Sandbox;
let main: string;

beforeAll(async () => {
	box = await sandbox();
	main = await box.project("t63dbhooks", {
		"basepad.config.ts": config,
		".gitignore": "node_modules\n.env.local\nmarker\nfail-*\n",
	});
	const up = await box.basepad(main, "up");
	expect(up.stderr).toBe("");
	await sql("create table items (name text); insert into items values ('saved')");
}, 300_000);
afterAll(() => box?.dispose());

async function sql(query: string): Promise<string> {
	const url = (await readEnv(main, ".env.local")).DB_URL as string;
	const out = await box.psql([url], query);
	expect(out.stderr).toBe("");
	return out.stdout.trim();
}

const rows = () => sql("select coalesce(string_agg(name, ',' order by name), '') from items");

async function marker(): Promise<string[]> {
	const text = await readFile(join(main, "marker"), "utf8").catch(() => "");
	await rm(join(main, "marker"), { force: true });
	return text.split("\n").filter(Boolean);
}

const line = (event: string, details: Record<string, string> = {}) =>
	`${event} main service=db label=${details.label ?? ""} source=${details.source ?? ""} file=${details.file ?? ""} url=set`;

test("save, load and rm run their hooks around the work, with service, label and env file keys", async () => {
	const saved = await box.basepad(main, "db", "save", "base");
	expect(saved.code).toBe(0);
	expect(saved.stdout).toMatch(
		/Running beforeSave[\s\S]*said by beforeSave[\s\S]*Saved `db` as snapshot base\.[\s\S]*said by afterSave/,
	);
	expect(await marker()).toEqual([
		line("beforeSave", { label: "base" }),
		line("afterSave", { label: "base" }),
	]);

	await sql("insert into items values ('later')");
	expect((await box.basepad(main, "db", "load", "base")).code).toBe(0);
	expect(await rows()).toBe("saved");
	expect(await marker()).toEqual([
		line("beforeLoad", { label: "base" }),
		line("afterLoad", { label: "base" }),
	]);

	expect((await box.basepad(main, "db", "rm", "base")).code).toBe(0);
	expect(await marker()).toEqual([
		line("beforeDelete", { label: "base" }),
		line("afterDelete", { label: "base" }),
	]);
}, 120_000);

test("load or rm of a missing snapshot runs no hook", async () => {
	for (const verb of ["load", "rm"]) {
		const result = await box.basepad(main, "db", verb, "missing");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("missing");
		expect(result.stdout).not.toContain("Running");
	}
	expect(await marker()).toEqual([]);
}, 120_000);

test("import runs its hooks around a custom-format dump with the source, and none when not told yes", async () => {
	const dump = join(box.root, "items.dump");
	expect((await box.basepad(main, "db", "export", dump)).code).toBe(0);
	expect(await marker()).toEqual([
		line("beforeExport", { file: dump }),
		line("afterExport", { file: dump }),
	]);

	const unasked = await box.basepad(main, "db", "import", dump);
	expect(unasked.code).toBe(1);
	const declined = await box.onTerminal(main, "n\n", "db", "import", dump);
	expect(declined.code).toBe(1);
	expect(await marker()).toEqual([]);

	await sql("delete from items");
	expect((await box.basepad(main, "db", "import", dump, "--yes")).code).toBe(0);
	expect(await rows()).toBe("saved");
	expect(await marker()).toEqual([
		line("beforeImport", { source: dump }),
		line("afterImport", { source: dump }),
	]);
}, 120_000);

test("export to standard output stays a clean dump: hook output goes to standard error", async () => {
	const file = join(box.root, "stdout.dump");
	const result = await box.run("bash", [
		"-c",
		`cd '${main}' && '${process.execPath}' '${cli}' db export > '${file}'`,
	]);
	expect(result.code).toBe(0);
	expect(result.stderr).toContain("said by beforeExport");
	expect(result.stderr).toContain("said by afterExport");
	expect((await readFile(file)).subarray(0, 5).toString("latin1")).toBe("PGDMP");
	expect(await marker()).toEqual([line("beforeExport"), line("afterExport")]);

	await sql("delete from items");
	expect((await box.basepad(main, "db", "import", file, "--yes")).code).toBe(0);
	expect(await rows()).toBe("saved");
	await marker();
}, 120_000);

test("a failed before hook cancels the command; a failed after hook exits 1 and keeps the work", async () => {
	await writeFile(join(main, "fail-beforeSave"), "");
	const cancelled = await box.basepad(main, "db", "save", "guarded");
	await rm(join(main, "fail-beforeSave"));
	expect(cancelled.code).toBe(1);
	expect(cancelled.stderr).toContain(
		'beforeSave `test ! -e "fail-$BASEPAD_EVENT"` failed (exit 1).',
	);
	expect(await marker()).toEqual([line("beforeSave", { label: "guarded" })]);
	expect((await box.basepad(main, "db", "snapshots")).stdout).not.toContain("guarded");

	expect((await box.basepad(main, "db", "save", "kept")).code).toBe(0);
	await sql("insert into items values ('later')");
	await writeFile(join(main, "fail-afterLoad"), "");
	const failedAfter = await box.basepad(main, "db", "load", "kept");
	await rm(join(main, "fail-afterLoad"));
	expect(failedAfter.code).toBe(1);
	expect(failedAfter.stdout).toContain("Loaded snapshot kept into `db`.");
	expect(failedAfter.stderr).toContain("afterLoad");
	expect(await rows()).toBe("saved");
	await marker();
}, 120_000);
