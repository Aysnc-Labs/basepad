import { chmod, chown, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { BasepadError, exec, must } from "./exec.ts";

const NAME = "basepad";

/**
 * Who runs a server that refuses root. As a normal user, that's the user. As root (a cloud
 * container), it's an unprivileged system user, which basepad creates.
 */
export interface ServiceUser {
	/** Prefixes a command so it runs as the service user. */
	wrap(argv: readonly string[]): string[];
	/** Lets the service user reach these paths: traverse-only access on each ancestor, ownership of `owned`. */
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
		// Another basepad, such as a second project's `up`, may create the user at the same time.
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
		// signal reaches the server directly; runuser would stay in between.
		wrap: (argv) => [
			"setpriv",
			`--reuid=${uid}`,
			`--regid=${gid}`,
			"--clear-groups",
			"--",
			...argv,
		],
		async grant({ traverse, owned }) {
			// mise installs under /root (0700), so the service user can't even reach Postgres's binaries.
			// o+x on each ancestor grants passing through, without listing or reading anything.
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
