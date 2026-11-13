import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Sandbox, sandbox } from "./sandbox.ts";

let box: Sandbox;
let dir: string;
beforeAll(async () => {
	box = await sandbox();
	dir = await box.project("cli");
});
afterAll(() => box.dispose());

test("--help lists every command and the top flags", async () => {
	const out = await box.basepad(dir, "--help");
	expect(out.code).toBe(0);
	expect(out.stdout).toBe(
		[
			"Usage: basepad <command> [flags]",
			"",
			"Commands:",
			"  init          Write a starter basepad.config.ts in this folder",
			"  setup         Once per machine: trust basepad's certificate and drop the port from URLs",
			"  up            Start this project's services and apps, set its env files, then open mission control",
			"  down          Stop this project's apps and services; nothing is deleted",
			"  status        Show each app and service with its address and state",
			"  worktree add  Make a worktree of main, with its own databases, domains and env files",
			"  worktree ls   List main's worktrees with their branches and folders",
			"  worktree rm   Remove a worktree: its apps, databases, registrations and git worktree; its branch stays",
			"  prune         Remove what is left of worktrees whose folder is gone, after showing it",
			"  db save       Save this environment's database as a snapshot, replacing one of the same label",
			"  db load       Replace this environment's database with a snapshot, which is kept",
			"  db snapshots  List this environment's snapshots",
			"  db rm         Delete one of this environment's snapshots",
			"",
			"Flags:",
			"  -h, --help     Show this help",
			"  -v, --version  Show basepad's version",
			"",
			"Run `basepad <command> --help` for a command's flags.",
			"",
		].join("\n"),
	);
});

test("<command> --help shows that command's usage", async () => {
	const out = await box.basepad(dir, "status", "-h");
	expect(out.code).toBe(0);
	expect(out.stdout).toBe(
		[
			"Usage: basepad status [flags]",
			"",
			"Show each app and service with its address and state.",
			"",
			"Flags:",
			"  -h, --help  Show this help",
			"",
		].join("\n"),
	);
});

test("up's and setup's help show their own flags", async () => {
	const up = await box.basepad(dir, "up", "--help");
	expect(up.stdout).toContain(
		"      --claim   Make this folder the owner of the project's databases, which another checkout under the same name holds\n",
	);
	const setup = await box.basepad(dir, "setup", "--help");
	expect(setup.stdout).toContain("      --dry-run  Print the plan and change nothing\n");
	expect(setup.stdout).toContain("  -y, --yes      Apply the plan without asking\n");
});

test("a two-word command takes its flags after both words", async () => {
	const help = await box.basepad(dir, "worktree", "add", "--help");
	expect(help.stdout).toContain("Usage: basepad worktree add [flags]\n");
	expect(help.stdout).toContain(
		"      --json           Print only the worktree's name and path, as JSON\n",
	);
	expect(help.stdout).toContain("      --branch <name>  Check out this branch,");
	const typo = await box.basepad(dir, "worktree", "ad");
	expect(typo.code).toBe(1);
	expect(typo.stderr).toBe(
		"basepad: Unknown command `worktree ad`. The nearest is `worktree add`; run `basepad --help` for every command.\n",
	);
});

test("a flag that takes a value says so when it has none", async () => {
	const out = await box.basepad(dir, "worktree", "add", "--branch");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		"basepad: `--branch` needs a name: `basepad worktree add --branch <name>`.\n",
	);
});

test("a command's arguments are in its usage, and a missing one shows it", async () => {
	const help = await box.basepad(dir, "worktree", "rm", "--help");
	// Optional, as `--claude` takes the worktree from its input.
	expect(help.stdout).toContain("Usage: basepad worktree rm [<worktree>] [flags]\n");
	const missing = await box.basepad(dir, "worktree", "rm", "--force");
	expect(missing.code).toBe(1);
	expect(missing.stderr).toBe("basepad: Usage: basepad worktree rm <worktree> [flags]\n");
});

test("a mistyped command names the nearest and exits non-zero", async () => {
	const out = await box.basepad(dir, "stauts");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		"basepad: Unknown command `stauts`. The nearest is `status`; run `basepad --help` for every command.\n",
	);
});

test("a mistyped flag names the nearest and exits non-zero", async () => {
	const out = await box.basepad(dir, "status", "--hlep");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		"basepad: `basepad status` has no flag `--hlep`. The nearest is `--help`; run `basepad status --help` for its flags.\n",
	);
});

/** A fake `mise` alone on PATH, printing `version`. */
async function fakeMise(version: string): Promise<string> {
	const bin = join(box.root, `mise-${version}`);
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "mise"), `#!/bin/sh\necho "${version} macos-arm64 (2026-01-01)"\n`);
	await chmod(join(bin, "mise"), 0o755);
	return bin;
}

test("with no mise on PATH, any command says what to install", async () => {
	const empty = join(box.root, "empty-bin");
	await mkdir(empty, { recursive: true });
	const out = await box.basepadWith({ env: { PATH: empty } }, dir, "--help");
	expect(out.code).toBe(1);
	expect(out.stdout).toBe("");
	expect(out.stderr).toBe(
		"basepad: basepad needs mise 2026.10.24 or newer, and `mise` is not on PATH. Install it: https://mise.jdx.dev/getting-started.html\n",
	);
});

test("with a mise older than the floor, any command says to update it", async () => {
	const out = await box.basepadWith({ env: { PATH: await fakeMise("2026.10.23") } }, dir, "status");
	expect(out.code).toBe(1);
	expect(out.stderr).toBe(
		"basepad: basepad needs mise 2026.10.24 or newer; this is mise 2026.10.23. Update mise (`mise self-update`, or the way you installed it).\n",
	);
});

test("a mise at the floor is accepted", async () => {
	const out = await box.basepadWith({ env: { PATH: await fakeMise("2026.10.24") } }, dir, "--help");
	expect(out.code).toBe(0);
});
