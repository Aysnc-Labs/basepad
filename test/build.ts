import { execFileSync } from "node:child_process";

export default function setup(): void {
	execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
