import { expect, test } from "vitest";
import { startFailure } from "../src/supervisor.ts";

const LOGS = "pitchfork logs neon-proxy/db-neon-proxy";

test("a daemon that exits on start shows its last output and how to see more", () => {
	expect(startFailure("web", ["Error: boom"], LOGS)).toBe(
		`\`web\` exited on start. Its last output:\n  Error: boom\nFor more, run: ${LOGS}`,
	);
	expect(startFailure("web", [], LOGS)).toBe(
		`\`web\` exited on start. Its last output:\n  (none)\nFor more, run: ${LOGS}`,
	);
});

test("a program too new for the system's glibc says which glibc it needs", () => {
	const loader =
		"/root/.local/share/mise/installs/github-aysnc-labs-prebuilt-binaries/neon-proxy-8853/bin/neon-proxy: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /root/.local/share/mise/installs/github-aysnc-labs-prebuilt-binaries/neon-proxy-8853/bin/neon-proxy)";
	expect(startFailure("db-neon-proxy", [loader], LOGS)).toBe(
		`\`db-neon-proxy\` needs glibc 2.39 or newer (Ubuntu 24.04, Debian 13), and this system's is older. Its last output:\n  ${loader}\nFor more, run: ${LOGS}`,
	);
});

test("a program missing several glibc versions names the highest", () => {
	const missing = (version: string) =>
		`/opt/neon-proxy: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_${version}' not found (required by /opt/neon-proxy)`;
	const lines = ["2.34", "2.39", "2.4", "2.38"].map(missing);
	expect(startFailure("db-neon-proxy", lines, LOGS)).toMatch(
		/^`db-neon-proxy` needs glibc 2\.39 or newer \(Ubuntu 24\.04, Debian 13\), and this system's is older\./,
	);
});

test("a service names the program that failed to start", () => {
	const program = "/root/.local/share/mise/installs/postgres/18.7-1/bin/postgres";
	expect(startFailure("db", ["FATAL: boom"], LOGS, program)).toBe(
		`\`db\` exited on start. Its last output:\n  FATAL: boom\nIts program: ${program}\nFor more, run: ${LOGS}`,
	);
});

test("the glibc advice knows Debian 13 and Ubuntu 26.04, and still names an unknown glibc", () => {
	const missing = (version: string) =>
		`/opt/redis-server: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_${version}' not found (required by /opt/redis-server)`;
	const why = (version: string) =>
		startFailure("cache", [missing(version)], LOGS).split(" Its last")[0];
	expect(why("2.41")).toBe(
		"`cache` needs glibc 2.41 or newer (Debian 13, Ubuntu 26.04), and this system's is older.",
	);
	expect(why("2.43")).toBe(
		"`cache` needs glibc 2.43 or newer (Ubuntu 26.04), and this system's is older.",
	);
	expect(why("2.47")).toBe("`cache` needs glibc 2.47 or newer, and this system's is older.");
});
