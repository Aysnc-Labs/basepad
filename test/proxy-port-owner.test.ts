import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

const CLEARS_PROXY_PORT =
	/BASEPAD_PROXY_PORT["'`\]]*\s*[:=]\s*(""|''|``|undefined)|delete\s+[^;\n]*BASEPAD_PROXY_PORT/;

test("only setup.test.ts clears BASEPAD_PROXY_PORT, so only it takes port 443 as root on Linux", async () => {
	const dir = import.meta.dirname;
	const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith(".ts"));
	const clearing = [];
	for (const file of files) {
		if (CLEARS_PROXY_PORT.test(await readFile(join(dir, file), "utf8"))) clearing.push(file);
	}
	expect(clearing).toEqual(["setup.test.ts"]);
});
