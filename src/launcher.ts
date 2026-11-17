#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MISE_MIN_VERSION, NODE_MAJOR } from "./versions.ts";

const INSTALL_MISE = "https://mise.jdx.dev/getting-started.html";

function fail(message: string): never {
	process.stderr.write(`basepad: ${message}\n`);
	process.exit(1);
}

function calver(version: string): number[] {
	return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function older(version: string, floor: string): boolean {
	const a = calver(version);
	const b = calver(floor);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] || 0;
		const y = b[i] || 0;
		if (x !== y) return x < y;
	}
	return false;
}

const probe = spawnSync("mise", ["--version"], { encoding: "utf8" });
if (probe.error) {
	fail(
		`basepad needs mise ${MISE_MIN_VERSION} or newer, and \`mise\` is not on PATH. Install it: ${INSTALL_MISE}`,
	);
}
const found = /\d+\.\d+\.\d+/.exec(probe.stdout || "");
if (!found) {
	fail(
		`basepad needs mise ${MISE_MIN_VERSION} or newer, and \`mise --version\` printed no version. Reinstall mise: ${INSTALL_MISE}`,
	);
}
if (older(found[0], MISE_MIN_VERSION)) {
	fail(
		`basepad needs mise ${MISE_MIN_VERSION} or newer; this is mise ${found[0]}. Update mise (\`mise self-update\`, or the way you installed it).`,
	);
}

const major = Number(process.versions.node.split(".")[0]);
if (major >= NODE_MAJOR) {
	await import("./cli.ts");
} else {
	const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
	const child = spawnSync(
		"mise",
		["exec", `node@${NODE_MAJOR}`, "--", "node", cli].concat(process.argv.slice(2)),
		{ stdio: "inherit", env: Object.assign({}, process.env, { BASEPAD_PATH: process.env.PATH }) },
	);
	if (child.error)
		fail(`could not run basepad on Node ${NODE_MAJOR} through mise: ${child.error.message}`);
	process.exit(child.status === null ? 1 : child.status);
}
