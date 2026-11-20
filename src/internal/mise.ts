import { shellQuote } from "./exec.ts";

export function throughMise(command: string): string {
	return `exec mise x -- sh -c ${shellQuote(command)}`;
}
