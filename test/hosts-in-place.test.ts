import { readFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { dropHosts, syncHosts } from "../src/hosts.ts";

const rootOnLinux = process.platform === "linux" && process.getuid?.() === 0;
const mountedHosts = async () =>
	(await readFile("/proc/self/mountinfo", "utf8"))
		.split("\n")
		.some((line) => line.split(" ")[4] === "/etc/hosts");

afterAll(async () => {
	if (rootOnLinux) await dropHosts("b5hosts");
});

test.runIf(rootOnLinux)(
	"a bind-mounted /etc/hosts gets a project's domains, then loses them",
	async () => {
		expect(await mountedHosts()).toBe(true);
		expect(await syncHosts("b5hosts", ["web.b5hosts.localhost"])).toEqual([
			"Added b5hosts's domains to /etc/hosts.",
		]);
		expect(await readFile("/etc/hosts", "utf8")).toContain("127.0.0.1 web.b5hosts.localhost\n");
		await dropHosts("b5hosts");
		expect(await readFile("/etc/hosts", "utf8")).not.toContain("b5hosts");
	},
);
