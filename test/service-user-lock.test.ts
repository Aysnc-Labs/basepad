import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { BasepadError } from "../src/internal/exec.ts";
import { rootOnlyDir, serviceUser } from "../src/internal/service-user.ts";

const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const name = `bplock${process.pid}`;
const NOBODY = "65534";
const run = promisify(execFile);

afterAll(async () => {
	if (rootOnLinux) await run("userdel", [name]).catch(() => {});
});

test.runIf(rootOnLinux)(
	"another user cannot take the service-user lock to stall root's basepad",
	async () => {
		await serviceUser(name);
		const held = run(
			"setpriv",
			[
				`--reuid=${NOBODY}`,
				`--regid=${NOBODY}`,
				"--clear-groups",
				"flock",
				"/run/basepad/service-user.lock",
				"sleep",
				"8",
			],
			{ timeout: 10_000 },
		);
		await expect(held).rejects.toThrow(/Permission denied/);
		const outcome = await Promise.race([
			serviceUser(name).then(() => "done"),
			new Promise((resolve) => setTimeout(() => resolve("stalled"), 4_000)),
		]);
		expect(outcome).toBe("done");
	},
	15_000,
);

test.runIf(rootOnLinux)(
	"a lock directory that is not a directory fails with the reason, not a stack trace",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "bplockdir-"));
		try {
			await writeFile(join(root, "file"), "");
			await symlink(join(root, "nowhere"), join(root, "dangling"));
			for (const planted of ["file", "dangling"]) {
				const failure = rootOnlyDir(join(root, planted));
				await expect(failure).rejects.toBeInstanceOf(BasepadError);
				await expect(failure).rejects.toThrow(/only root can enter/);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test.runIf(rootOnLinux)(
	"a missing parent of the lock directory gets ordinary permissions",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "bplockdir-"));
		try {
			await mkdir(join(root, "ordinary"));
			await rootOnlyDir(join(root, "run/basepad"));
			const ordinary = (await stat(join(root, "ordinary"))).mode & 0o777;
			expect((await stat(join(root, "run"))).mode & 0o777).toBe(ordinary);
			expect((await stat(join(root, "run/basepad"))).mode & 0o777).toBe(0o700);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
