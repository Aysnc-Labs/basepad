import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Invocation } from "./commands.ts";
import { CONFIG_FILE, LOCAL_FILE } from "./config.ts";
import { BasepadError } from "./internal/exec.ts";

/**
 * `basepad init`: a starter config named from the folder, the local file kept out of git, and
 * basepad added as a devDependency.
 */

const PACKAGE = "basepad";

export async function init({ cwd, print }: Invocation): Promise<void> {
	const file = join(cwd, CONFIG_FILE);
	if (existsSync(file)) {
		throw new BasepadError(`${file} already exists; \`basepad init\` leaves it as it is.`);
	}
	const name = labelOf(basename(cwd));
	await writeFile(file, starter(name));
	print(`Wrote ${CONFIG_FILE} with name "${name}".`);
	if (await ignoreLocalFile(cwd)) print(`Added ${LOCAL_FILE} to .gitignore.`);
	if (await addDevDependency(cwd)) {
		print(
			`Added ${PACKAGE} to devDependencies in package.json; install it with your package manager.`,
		);
	}
}

/** A folder's name as a lowercase DNS label. Never truncated: `status` says when it is too long. */
function labelOf(folder: string): string {
	const label = folder
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return label || "project";
}

function starter(name: string): string {
	return `import { defineConfig } from "${PACKAGE}";

export default defineConfig({
	name: ${JSON.stringify(name)},
	// services: {
	// 	db: postgres({ version: 18 }), // import postgres from "${PACKAGE}" too
	// },
	apps: {
		// web: { run: "npm run dev" }, // https://web.${name}.localhost
	},
	// env: ({ db, web }) => ({
	// 	".env.local": { DATABASE_URL: db.url, APP_URL: web.url },
	// }),
});
`;
}

/** Adds the local file to `.gitignore`, creating it. Returns whether it changed anything. */
async function ignoreLocalFile(cwd: string): Promise<boolean> {
	const file = join(cwd, ".gitignore");
	const text = await readFile(file, "utf8").catch(() => "");
	const lines = text.split(/\r?\n/).map((line) => line.trim());
	if (lines.includes(LOCAL_FILE) || lines.includes(`/${LOCAL_FILE}`)) return false;
	const gap = text === "" || text.endsWith("\n") ? "" : "\n";
	await writeFile(file, `${text}${gap}${LOCAL_FILE}\n`);
	return true;
}

/** Adds basepad to `package.json`'s devDependencies when the file exists and lacks it. */
async function addDevDependency(cwd: string): Promise<boolean> {
	const file = join(cwd, "package.json");
	const text = await readFile(file, "utf8").catch(() => undefined);
	if (text === undefined) return false;
	let pkg: Record<string, unknown>;
	try {
		pkg = JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new BasepadError(`${file} is not valid JSON: ${(error as Error).message}`);
	}
	const has = (field: string) =>
		typeof pkg[field] === "object" && pkg[field] !== null && PACKAGE in (pkg[field] as object);
	if (has("dependencies") || has("devDependencies")) return false;
	pkg.devDependencies = {
		...(pkg.devDependencies as object | undefined),
		[PACKAGE]: `^${await ownVersion()}`,
	};
	const indent = /^[ \t]+/m.exec(text)?.[0] ?? "\t";
	await writeFile(file, `${JSON.stringify(pkg, null, indent)}\n`);
	return true;
}

async function ownVersion(): Promise<string> {
	const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
	return (JSON.parse(text) as { version: string }).version;
}
