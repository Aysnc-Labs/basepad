import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { clonePaths } from "../src/worktrees.ts";

const run = promisify(execFile);
const onMac = process.platform === "darwin";
let root: string;
let volume: string;

beforeAll(async () => {
	if (!onMac) return;
	root = await mkdtemp(join(tmpdir(), "basepad-hfs-"));
	volume = join(root, "volume");
	const image = join(root, "plain.dmg");
	await run("hdiutil", [
		"create",
		"-quiet",
		"-size",
		"8m",
		"-fs",
		"HFS+",
		"-volname",
		"b5hfs",
		image,
	]);
	await run("hdiutil", ["attach", "-quiet", "-nobrowse", "-mountpoint", volume, image]);
}, 60_000);

afterAll(async () => {
	if (!onMac) return;
	await run("hdiutil", ["detach", "-quiet", "-force", volume]).catch(() => undefined);
	await rm(root, { recursive: true, force: true });
});

test.runIf(onMac)(
	"on macOS, worktrees.clone copies onto a volume that cannot clone files",
	async () => {
		const main = join(root, "main");
		await mkdir(join(main, "storage/app"), { recursive: true });
		await writeFile(join(main, "storage/app/a.txt"), "folder file");
		await writeFile(join(main, ".env"), "KEY=value\n");
		expect((await run("diskutil", ["info", volume])).stdout).toMatch(/Type \(Bundle\):\s+hfs\n/);
		const worktree = join(volume, "worktree");
		await mkdir(worktree);
		expect(await clonePaths(main, worktree, ["storage", ".env"])).toEqual([]);
		expect(await readFile(join(worktree, "storage/app/a.txt"), "utf8")).toBe("folder file");
		expect(await readFile(join(worktree, ".env"), "utf8")).toBe("KEY=value\n");
	},
);
