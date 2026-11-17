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
