import { chmod, chown, lstat, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { BasepadError, must } from "./exec.ts";

const NAME = "basepad";
const LOCK_DIR = "/run/basepad";
const CREATE_LOCK = `${LOCK_DIR}/service-user.lock`;

export interface ServiceUser {
	wrap(argv: readonly string[]): string[];
	grant(paths: { traverse: readonly string[]; owned: readonly string[] }): Promise<void>;
}

const self: ServiceUser = { wrap: (argv) => [...argv], grant: async () => {} };

export async function serviceUser(name = NAME): Promise<ServiceUser> {
	if (process.getuid?.() !== 0) return self;
	if (process.platform !== "linux") {
		throw new BasepadError(
			"As root, basepad runs services as a system user, which it supports on Linux only.",
		);
	}
	await rootOnlyDir(LOCK_DIR);
	await must("flock", [
		CREATE_LOCK,
		"sh",
		"-c",
		`id -u ${name} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ${name}`,
	]);
	const uid = Number((await must("id", ["-u", name])).trim());
	const gid = Number((await must("id", ["-g", name])).trim());
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

async function rootOnlyDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const dir = await lstat(path);
	if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o077) !== 0) {
		throw new BasepadError(
			`${path} must be a directory only root can enter (owner root, mode 0700). Remove it and run basepad again.`,
		);
	}
}
