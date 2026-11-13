import { expect, test } from "vitest";
import { setKeys } from "../src/env-files.ts";

test("a key the file has is set in place; every other line stays as it was", () => {
	const text = "# secrets\nSECRET=hunter2\nAPP_URL=http://old\n\nOTHER=1\n";
	expect(setKeys(text, { APP_URL: "https://web.shop.localhost" })).toBe(
		"# secrets\nSECRET=hunter2\nAPP_URL=https://web.shop.localhost\n\nOTHER=1\n",
	);
});

test("a key the file lacks is appended, after a newline when the file has no final one", () => {
	expect(setKeys("SECRET=1", { A: "x", B: 2 })).toBe("SECRET=1\nA=x\nB=2\n");
	expect(setKeys("", { A: "x" })).toBe("A=x\n");
});

test("setting the same keys again changes nothing", () => {
	const keys = { APP_URL: "https://web.shop.localhost:7443", NOTE: "a b # c", Q: "it's" };
	const once = setKeys("# mine\nAPP_URL=old\n", keys);
	expect(setKeys(once, keys)).toBe(once);
});

test("a value already written another way that reads the same is left as written", () => {
	const text = `A="x"\nB='y' # mine\nC=z # mine\n`;
	expect(setKeys(text, { A: "x", B: "y", C: "z" })).toBe(text);
});

test("values that need quotes are quoted", () => {
	expect(setKeys("", { SPACES: "a b", HASH: "a#b", DOLLAR: "$x", EMPTY: "" })).toBe(
		"SPACES='a b'\nHASH='a#b'\nDOLLAR='$x'\nEMPTY=\n",
	);
	expect(setKeys("", { BOTH: `it's "x"` })).toBe(`BOTH="it's \\"x\\""\n`);
});

test("`export`, spacing and CRLF line endings are kept", () => {
	expect(setKeys("export A = old\r\nB=1\r\n", { A: "new", C: "c" })).toBe(
		"export A = new\r\nB=1\r\nC=c\r\n",
	);
});

test("a multi-line quoted value is replaced whole", () => {
	expect(setKeys('KEY="line1\nline2"\nNEXT=1\n', { KEY: "one" })).toBe("KEY=one\nNEXT=1\n");
});
