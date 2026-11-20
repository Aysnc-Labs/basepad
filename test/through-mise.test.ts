import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { throughMise } from "../src/internal/mise.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("throughMise hands a value to the command without it in any command line", async () => {
	const dir = await mkdtemp(join(tmpdir(), "through-mise-"));
	dirs.push(dir);
	const argv = join(dir, "mise-argv");
	await writeFile(
		join(dir, "mise"),
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${argv}\nshift 2\nexec "$@"\n`,
	);
	await chmod(join(dir, "mise"), 0o755);
	const secret = "t67-canary-secret";
	const script = throughMise("printenv API_SECRET", ["API_SECRET"]);

	const { stdout } = await promisify(execFile)("sh", ["-c", script], {
		env: { PATH: `${dir}:${process.env.PATH}`, API_SECRET: secret },
	});

	expect(stdout).toBe(`${secret}\n`);
	expect(script).not.toContain(secret);
	expect(await readFile(argv, "utf8")).not.toContain(secret);
});
