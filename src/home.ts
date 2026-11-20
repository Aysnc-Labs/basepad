import { homedir } from "node:os";
import { join } from "node:path";

export function basepadHome(env: NodeJS.ProcessEnv): string {
	return env.BASEPAD_HOME || join(env.HOME || homedir(), ".basepad");
}
