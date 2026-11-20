import { shellQuote } from "./exec.ts";

export function throughMise(
	command: string,
	variables: Record<string, string> = {},
	fromParent: string[] = [],
): string {
	const assignments = [
		...Object.entries(variables).map(([name, value]) => shellQuote(`${name}=${value}`)),
		...fromParent.map((name) => `${name}="$${name}"`),
	];
	const env = assignments.length > 0 ? `env ${assignments.join(" ")} ` : "";
	return `exec mise x -- ${env}sh -c ${shellQuote(command)}`;
}
