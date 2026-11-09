import { access } from "node:fs/promises";

/** Whether anything is at `path`. */
export async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
