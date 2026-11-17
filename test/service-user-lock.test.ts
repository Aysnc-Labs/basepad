import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { BasepadError } from "../src/internal/exec.ts";
import { rootOnlyDir, SERVICE_USER_LOCK, serviceUser } from "../src/internal/service-user.ts";

const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const name = `bplock${process.pid}`;
const NOBODY = "65534";
const run = promisify(execFile);

afterAll(async () => {
	if (rootOnLinux) await run("userdel", [name]).catch(() => {});
});

function within<T>(ms: number, work: Promise<T>): Promise<T | "stalled"> {
	let timer: NodeJS.Timeout | undefined;
	const stalled = new Promise<"stalled">((resolve) => {
		timer = setTimeout(() => resolve("stalled"), ms);
	});
	return Promise.race([work, stalled]).finally(() => clearTimeout(timer));
}

function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

test.runIf(rootOnLinux)(
	"another user cannot hold the service-user lock to stall root's basepad",
	async () => {
		await serviceUser(name);
		const held = spawn(
			"setpriv",
			[
				`--reuid=${NOBODY}`,
				`--regid=${NOBODY}`,
				"--clear-groups",
				"flock",
				SERVICE_USER_LOCK,
				"sleep",
				"8",
			],
			{ stdio: "ignore", detached: true },
		);
		const exited = new Promise((resolve, reject) => {
			held.once("exit", resolve);
			held.once("error", reject);
		});
		try {
			await within(1_000, exited);
			const created = serviceUser(name).then(() => "done");
			expect(await within(4_000, created)).toBe("done");
		} finally {
			killGroup(held.pid);
			await exited;
		}
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
