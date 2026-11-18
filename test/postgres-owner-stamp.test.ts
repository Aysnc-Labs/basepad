import { afterAll, beforeAll, expect, test } from "vitest";
import { stampOwnerAndCheck } from "../src/catalogue/postgres.ts";
import { configFile, type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
let dir: string;

beforeAll(async () => {
	box = await sandbox();
	dir = await box.project("stamp", {
		"basepad.config.ts": configFile(`{
	name: "b5stamp",
	services: { db: postgres() },
	env: ({ db }) => ({ ".env.local": { DATABASE_URL: db.url } }),
}`),
	});
	const up = await box.basepad(dir, "up");
	expect(up.stderr).toBe("");
}, 300_000);
afterAll(() => box?.dispose());

const sql = async (text: string) => {
	const out = await box.sql(dir, text);
	if (out.code !== 0) throw new Error(out.stderr);
	return out.stdout.trim();
};

test("stamping the owner of a database that has gone fails, though Postgres only warns", async () => {
	const comment = await box.sql(dir, "comment on database b5stamp_gone is 'main'");
	expect(comment.code).toBe(0);
	expect(comment.stderr).toContain('database "b5stamp_gone" does not exist');
	await expect(stampOwnerAndCheck(sql, "b5stamp_gone", "main")).rejects.toThrow(
		"Could not mark `b5stamp_gone` as belonging to main.",
	);
});

test("stamping the owner of a database that exists records it", async () => {
	await sql("create database b5stamp_here");
	await stampOwnerAndCheck(sql, "b5stamp_here", "worktree-1");
	expect(
		await sql(
			"select shobj_description(oid, 'pg_database') from pg_database where datname = 'b5stamp_here'",
		),
	).toBe("worktree-1");
});
