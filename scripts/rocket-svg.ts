import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rocketArt } from "../src/mission-control/launch.ts";

const art = rocketArt();
const PX = 10;
const MARGIN = 20;
const width = art.wide * PX + MARGIN * 2;
const height = art.tall * PX + MARGIN * 2;

function rects(rows: string[], x = 0, y = 0): string {
	const out: string[] = [];
	for (const [dy, row] of rows.entries()) {
		const chars = [...row];
		for (let i = 0; i < chars.length; ) {
			const ch = chars[i] as string;
			let j = i;
			while (chars[j] === ch) j++;
			const fill = art.colours[ch];
			if (ch !== "." && fill !== undefined)
				out.push(
					`<rect x="${(x + i) * PX}" y="${(y + dy) * PX}" width="${(j - i) * PX}" height="${PX}" fill="${fill}"/>`,
				);
			i = j;
		}
	}
	return out.join("");
}

const arms = [art.top + 4, art.top + 10, art.top + 16].map((y) =>
	rects(["T".repeat(art.x + 2 - 10)], 10, y),
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-label="basepad's rocket on its launch pad">
<rect width="${width}" height="${height}" rx="16" fill="#1a1b26"/>
<g transform="translate(${MARGIN} ${MARGIN})">
${rects(art.ground)}
${rects(["R"], art.beacon[0], art.beacon[1])}
${arms.join("")}
${rects(art.rocket, art.x, art.top)}
</g>
</svg>
`;

const file = new URL("../docs/rocket.svg", import.meta.url);
if (process.argv.includes("--check")) {
	if (!existsSync(file) || readFileSync(file, "utf8") !== svg) {
		console.error("docs/rocket.svg is out of date with the art: run `node scripts/rocket-svg.ts`.");
		process.exit(1);
	}
} else {
	writeFileSync(file, svg);
	console.log(`docs/rocket.svg: ${svg.length} bytes`);
}
