import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { serviceUser } from "../src/internal/service-user.ts";

const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const name = `bprace${process.pid}`;
const run = promisify(execFile);

afterAll(async () => {
	if (rootOnLinux) await run("userdel", [name]).catch(() => {});
});

test.runIf(rootOnLinux)(
	"basepads that create the service user at once all get the one user",
	async () => {
		const users = await Promise.all(Array.from({ length: 6 }, () => serviceUser(name)));
		const ids = users.map((user) => user.wrap([]).slice(1, 3).join(" "));
		const uid = (await run("id", ["-u", name])).stdout.trim();
		const gid = (await run("id", ["-g", name])).stdout.trim();
		expect(ids).toEqual(Array(6).fill(`--reuid=${uid} --regid=${gid}`));
	},
);
