import { shellQuote } from "./exec.ts";

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STASH = "__BASEPAD_";

export function throughMise(command: string, names: string[] = []): string {
	const carried = names.filter((name) => SHELL_NAME.test(name));
	const stash = carried.map((name) => `${STASH}${name}="$${name}" `).join("");
	const restore = carried
		.map((name) => `export ${name}="$${STASH}${name}"; unset ${STASH}${name}; `)
		.join("");
	return `${stash}exec mise x -- sh -c ${shellQuote(`${restore}${command}`)}`;
}
