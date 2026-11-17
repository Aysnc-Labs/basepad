import { chmod, chown, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { BasepadError, exec, must } from "./exec.ts";

const NAME = "basepad";

export interface ServiceUser {
	wrap(argv: readonly string[]): string[];
	grant(paths: { traverse: readonly string[]; owned: readonly string[] }): Promise<void>;
}

const self: ServiceUser = { wrap: (argv) => [...argv], grant: async () => {} };

export async function serviceUser(): Promise<ServiceUser> {
	if (process.getuid?.() !== 0) return self;
	if (process.platform !== "linux") {
		throw new BasepadError(
			"As root, basepad runs services as a system user, which it supports on Linux only.",
		);
	}
	const exists = async () => (await exec("id", ["-u", NAME])).code === 0;
	if (!(await exists())) {
		await must("useradd", [
			"--system",
			"--no-create-home",
			"--shell",
			"/usr/sbin/nologin",
			NAME,
		]).catch(async (error) => {
			if (!(await exists())) throw error;
		});
	}
	const uid = Number((await must("id", ["-u", NAME])).trim());
	const gid = Number((await must("id", ["-g", NAME])).trim());
	return {
		// setpriv execs the program itself, so the supervisor's pid is the server's and its stop
		// signal reaches the server directly; runuser would stay in between:
		// https://man7.org/linux/man-pages/man1/setpriv.1.html
		wrap: (argv) => [
			"setpriv",
			`--reuid=${uid}`,
			`--regid=${gid}`,
			"--clear-groups",
			"--",
			...argv,
		],
		async grant({ traverse, owned }) {
			for (const path of traverse) {
				for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) {
					const { mode } = await stat(dir);
					if ((mode & 0o001) === 0) await chmod(dir, mode | 0o001);
				}
			}
			for (const path of owned) await chown(path, uid, gid);
		},
	};
}
