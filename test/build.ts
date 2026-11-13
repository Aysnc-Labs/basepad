import { execFileSync } from "node:child_process";

/** Tests run the CLI the way it ships: the compiled bin, built once per run. */
export default function setup(): void {
	execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
