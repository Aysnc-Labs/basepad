import { rename, rm } from "node:fs/promises";

export async function writeWhole(
	file: string,
	write: (partial: string) => Promise<unknown>,
): Promise<void> {
	const partial = `${file}.${process.pid}.partial`;
	try {
		await write(partial);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	await rename(partial, file);
}
