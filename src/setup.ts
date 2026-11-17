import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Invocation } from "./commands.ts";
import { BasepadError, exec } from "./internal/exec.ts";
import { isRootOnLinux, type Machine, machine } from "./layout.ts";
import type { Check } from "./mission-control/launch.ts";
import { openSupervisor, type Supervisor } from "./supervisor.ts";

export async function setup({ flags, print }: Invocation): Promise<void> {
	const here = machine(process.env);
	const supervisor = await openSupervisor(here, print);
	await supervisor.serve();
	const root = isRootOnLinux();
	const stores = process.platform === "linux" ? await nssStores() : [];

	const port = await supervisor.standardPort();
	if (port === "other") {
		print(
			"Warning: something other than basepad's proxy answers on port 443 (Herd, Valet, or a pitchfork of your own?). Redirecting 443 sends this machine's own traffic for that port to basepad instead.",
		);
	}
	const mac = process.platform === "darwin" && !root;
	const macPlan = mac ? await planForMac(here, supervisor) : undefined;
	const plan = root
		? [
				"trust basepad's CA in the system trust store",
				"the proxy listens on port 443 itself, so no redirect is needed",
			]
		: (macPlan?.steps ?? (await supervisor.proxySetupPlan()));
	if (stores.length > 0) plan.push(await nssStep(stores));
	if (plan.length === 0) {
		if (process.stdout.isTTY) {
			const pad = await launchPad(["trust basepad's CA", "port 443 reaches basepad's proxy"], mac);
			pad.go(0);
			if (port === "proxy") await pad.liftOff(true, print);
			else {
				pad.fail(print);
				print(portKept(mac, here));
			}
		}
		print("basepad setup: nothing to do; basepad's CA is already trusted.");
		return;
	}
	const pad = process.stdout.isTTY ? await launchPad(plan, mac) : undefined;
	pad?.show(print);
	print("basepad setup will:");
	for (const step of plan) print(`  ${step}`);
	if (!mac) {
		print(
			`Then app URLs drop the port: https://<app>.<name>.localhost. URLs carry :${here.proxyPort} until then.`,
		);
	}

	const clash = root ? undefined : await ownPitchforkSetup(supervisor);
	if (clash) throw new BasepadError(`Nothing was changed: ${clash}`);
	if (flags["dry-run"]) {
		print("Dry run: nothing was changed.");
		return;
	}
	if (!root && !flags.yes && !(await consent())) return;

	try {
		if (root) await supervisor.trust();
		else if (macPlan !== undefined) {
			if (macPlan.removeRedirect) {
				const code = await supervisor.proxyUndo();
				if (code !== 0)
					throw new BasepadError(`pitchfork's proxy setup --undo failed (exit ${code}).`);
				pad?.go(0);
			}
			if (!macPlan.trusted || macPlan.removeRedirect) await supervisor.trust();
		} else {
			const code = await supervisor.proxySetup();
			if (code !== 0) throw new BasepadError(`pitchfork's proxy setup failed (exit ${code}).`);
		}
	} catch (error) {
		pad?.fail(print);
		throw error;
	}
	for (const line of await trustInBrowsers(supervisor.ca, stores)) print(line);
	const portFree = (await supervisor.standardPort()) === "proxy";
	await pad?.liftOff(portFree, print);
	if (portFree) {
		print("URLs are port-free: https://<app>.<name>.localhost");
		print("Run `basepad up` in each project to write the port-free URLs into its env files.");
	} else print(portKept(mac, here));
}

function portKept(mac: boolean, here: Machine): string {
	return mac
		? here.forwards443
			? `Something else answers on port 443 (Herd, Valet?), so URLs keep :${here.proxyPort}.`
			: `BASEPAD_PROXY_PORT is set, so URLs keep :${here.proxyPort}.`
		: `Port 443 does not reach basepad's proxy yet, so URLs keep :${here.proxyPort}. Run \`basepad setup\` again.`;
}

interface Pad {
	show(print: (line: string) => void): void;
	go(i: number): void;
	fail(print: (line: string) => void): void;
	liftOff(portFree: boolean, print: (line: string) => void): Promise<void>;
}

async function launchPad(plan: string[], mac: boolean): Promise<Pad> {
	const [{ launchFrame, liftOff }, { colorsFor }, { default: chalk }, { renderToString }] =
		await Promise.all([
			import("./mission-control/launch.ts"),
			import("./mission-control/frame.ts"),
			import("chalk"),
			import("ink"),
		]);
	const checks: Check[] = plan.map((step, i) => ({ name: checkOf(step, i), state: "waiting" }));
	const input = () => ({
		title: "SETUP",
		subtitle: mac ? "this mac" : "this machine",
		checks,
		tick: 0,
		lift: 0,
		cols: process.stdout.columns || 80,
		color: colorsFor(process.env.NO_COLOR, chalk.level),
	});
	const show = (print: (line: string) => void) =>
		print(renderToString(launchFrame(input()), { columns: process.stdout.columns || 80 }));
	return {
		show,
		go(i) {
			const check = checks[i];
			if (check !== undefined) check.state = "go";
		},
		fail(print) {
			for (const check of checks) if (check.state !== "go") check.state = "nogo";
			show(print);
		},
		async liftOff(portFree, print) {
			for (const check of checks) check.state = "go";
			if (portFree) await liftOff(input());
			else show(print);
		},
	};
}

function checkOf(step: string, i: number): string {
	if (/pf redirect/.test(step)) return "REMOVE PF REDIRECT";
	if (/Chrome and Firefox/.test(step)) return "BROWSERS";
	if (/\b443\b/.test(step)) return "PORT 443";
	if (/\bCA\b/.test(step)) return "TRUST CA";
	return `STEP ${i + 1}`;
}

async function consent(): Promise<boolean> {
	if (!process.stdin.isTTY) {
		throw new BasepadError(
			"Nothing was changed: there is no terminal to ask for consent. Run `basepad setup --yes` to apply the plan above.",
		);
	}
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await prompt.question(
		"Apply it? Steps marked [sudo] ask for your password. [y/N] ",
	);
	prompt.close();
	if (/^y(es)?$/i.test(answer.trim())) return true;
	console.log("Nothing was changed.");
	return false;
}

export async function trustAsRoot(supervisor: Supervisor): Promise<string[]> {
	try {
		await supervisor.trust();
	} catch (error) {
		return [
			`Could not add basepad's CA to the system trust store: ${(error as Error).message}`,
			"Apps still trust it through NODE_EXTRA_CA_CERTS and PITCHFORK_CA_FILE.",
		];
	}
	return trustInBrowsers(supervisor.ca, await nssStores());
}

/**
 * A setup of a developer's own pitchfork that basepad's would overwrite: on Linux pitchfork writes
 * one CA file, whichever pitchfork runs it:
 * https://github.com/jdx/pitchfork/blob/v2.34.0/src/proxy/trust.rs#L13. Returns why, or nothing.
 */
async function ownPitchforkSetup(supervisor: Supervisor): Promise<string | undefined> {
	if (process.platform === "darwin") return undefined;
	const ours = await readFile(supervisor.ca, "utf8").catch(() => "");
	for (const dir of LINUX_CA_DIRS) {
		const installed = await readFile(join(dir, "pitchfork-proxy.crt"), "utf8").catch(
			() => undefined,
		);
		if (installed !== undefined && installed !== ours) {
			return `${join(dir, "pitchfork-proxy.crt")} trusts a pitchfork of your own, and basepad's setup would replace it. Remove that one first (\`sudo pitchfork proxy untrust\`), or keep the port in basepad's URLs.`;
		}
	}
	return undefined;
}

const PF_ANCHOR = "/etc/pf.anchors/pitchfork";

async function planForMac(
	here: Machine,
	supervisor: Supervisor,
): Promise<{ steps: string[]; trusted: boolean; removeRedirect: boolean }> {
	const rules = await readFile(PF_ANCHOR, "utf8").catch(() => undefined);
	const removeRedirect =
		rules !== undefined && new RegExp(`port ${here.proxyPort}\\s*$`, "m").test(rules);
	const trusted = (await supervisor.proxySetupPlan()).some((line) =>
		line.includes("is already trusted"),
	);
	const steps: string[] = [];
	if (removeRedirect) {
		steps.push(
			"[sudo] remove the pf redirect of port 443 an earlier basepad setup added: it turns off iCloud Private Relay",
		);
	}
	if (!trusted || removeRedirect) {
		steps.push(
			`trust basepad's CA at ${supervisor.ca} in your login keychain (macOS asks for Touch ID or your password)`,
		);
	}
	return { steps, trusted, removeRedirect };
}

const LINUX_CA_DIRS = [
	"/usr/local/share/ca-certificates",
	"/etc/pki/ca-trust/source/anchors",
	"/etc/ca-certificates/trust-source/anchors",
	"/etc/pki/trust/anchors",
];

/**
 * The NSS databases Chrome and Firefox read on Linux; pitchfork's trust does not reach them:
 * https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md
 */
async function nssStores(): Promise<string[]> {
	const home = process.env.HOME || homedir();
	const stores = [join(home, ".pki/nssdb")].filter((dir) => existsSync(join(dir, "cert9.db")));
	for (const firefox of [".mozilla/firefox", "snap/firefox/common/.mozilla/firefox"]) {
		const dir = join(home, firefox);
		const profiles = await readdir(dir).catch(() => []);
		for (const profile of profiles) {
			if (existsSync(join(dir, profile, "cert9.db"))) stores.push(join(dir, profile));
		}
	}
	return stores;
}

async function nssStep(stores: string[]): Promise<string> {
	return (await certutil())
		? `add basepad's CA to Chrome and Firefox (certutil): ${stores.join(", ")}`
		: "Chrome and Firefox keep their own certificate stores, and certutil is not installed: install it (Debian/Ubuntu: libnss3-tools; Fedora: nss-tools) and run `basepad setup` again, or they will warn";
}

async function certutil(): Promise<string | undefined> {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir && existsSync(join(dir, "certutil"))) return join(dir, "certutil");
	}
	return undefined;
}

async function trustInBrowsers(ca: string, stores: string[]): Promise<string[]> {
	const program = await certutil();
	if (!program || stores.length === 0) return [];
	const nickname = "basepad local CA";
	const lines: string[] = [];
	for (const store of stores) {
		const db = `sql:${store}`;
		await exec(program, ["-D", "-d", db, "-n", nickname]);
		const added = await exec(program, ["-A", "-d", db, "-n", nickname, "-t", "C,,", "-i", ca]);
		lines.push(
			added.code === 0
				? `Trusted basepad's CA in ${store}.`
				: `Could not add basepad's CA to ${store}: ${(added.stderr || added.stdout).trim()}`,
		);
	}
	return lines;
}
