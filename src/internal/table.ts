/** Rows as aligned columns, two spaces apart, the first row being the header. */
export function table(rows: string[][]): string {
	const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
	return rows
		.map((row) =>
			row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
		)
		.join("\n");
}
