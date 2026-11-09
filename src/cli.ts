#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { add } from "./internal/add.ts";
import { upInBackground } from "./internal/background.ts";
import { changed, ci } from "./internal/ci.ts";
import { claudeCreate, claudeRemove } from "./internal/claude.ts";
import { clone } from "./internal/clone.ts";
import { SERVICE_TYPES } from "./internal/config.ts";
import { BasepadError } from "./internal/exec.ts";
import { PRESETS } from "./internal/presets.ts";
import { status } from "./internal/status.ts";
import { addWorktree, listWorktrees, removeWorktree, start } from "./internal/worktree.ts";

const USAGE = `Usage: basepad <command>

Commands:
  add <service>... [--name <name>] [--preset <preset>]
                  Add services to this project's basepad.toml and start them
                  (services: ${SERVICE_TYPES.join(", ")}; presets: ${PRESETS.join(", ")})
  up [--background]
                  Start this project's services from basepad.toml and rewrite its env block
                  (--background: return at once, logging to basepad's home)
  status          List this project's services with their state, port and URL
  worktree add <name> [--path <dir>]
                  Make a git worktree with its own databases, Redis, port and env block
  worktree add --claude
                  The same, as Claude Code's WorktreeCreate hook: reads the name from the
                  hook's input on stdin, and prints only the worktree's path on stdout
  worktree remove <name> [--force]
                  Run its pre-remove hook, drop its databases, stop its services, remove it
  worktree remove --claude
                  The same, as Claude Code's WorktreeRemove hook: removes the worktree at the
                  input's worktree_path, even with uncommitted work, and its merged branch
  worktree ls     List this repo's worktrees with their state, ports and databases
  clone <path>... Copy paths from main into this worktree (copy-on-write where supported)
  changed [--base <ref>]
                  List the projects this change touches, by basepad.toml's [ci] rules
  ci [<project>...] [--all] [--base <ref>]
                  Run the checks of the projects this change touches (or the ones named)

Options:
  -h, --help      Show this help
  -v, --version   Show basepad's version`;

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			name: { type: "string" },
			preset: { type: "string" },
			path: { type: "string" },
			force: { type: "boolean" },
			base: { type: "string" },
			all: { type: "boolean" },
			claude: { type: "boolean" },
			background: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	const [command, ...rest] = positionals;
	if (values.version) {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version: string;
		};
		console.log(pkg.version);
		return 0;
	}
	if (values.help || command === undefined) {
		console.log(USAGE);
		return command === undefined && !values.help ? 1 : 0;
	}
	const cwd = process.cwd();
	// As a Claude Code hook, stdout carries only the worktree's path.
	if (values.claude) console.log = console.error;
	switch (command) {
		case "add": {
			if (rest.length === 0) throw new BasepadError(`\`basepad add\` needs a service.\n\n${USAGE}`);
			const lines = await add({
				cwd,
				services: rest,
				name: values.name,
				preset: values.preset,
			});
			for (const line of lines) console.log(line);
			return 0;
		}
		case "up": {
			if (rest.length > 0) throw new BasepadError(`\`basepad up\` takes no arguments.\n\n${USAGE}`);
			const lines = values.background ? await upInBackground(cwd) : await start(cwd);
			for (const line of lines) console.log(line);
			return 0;
		}
		case "worktree": {
			const [sub, name, ...extra] = rest;
			if (values.claude) {
				if (sub === "add" && name === undefined && values.path === undefined) {
					process.stdout.write(`${await claudeCreate(cwd)}\n`);
					return 0;
				}
				if (sub === "remove" && name === undefined) {
					for (const line of await claudeRemove()) console.error(line);
					return 0;
				}
				throw new BasepadError(
					"`--claude` takes `worktree add --claude` or `worktree remove --claude`, with no name: it reads Claude Code's hook input on stdin.",
				);
			}
			if (sub === "ls" && name === undefined) {
				console.log(await listWorktrees(cwd));
				return 0;
			}
			if ((sub === "add" || sub === "remove") && name !== undefined && extra.length === 0) {
				const lines =
					sub === "add"
						? await addWorktree({ cwd, name, path: values.path })
						: await removeWorktree({ cwd, name, force: values.force });
				for (const line of lines) console.log(line);
				return 0;
			}
			throw new BasepadError(
				`\`basepad worktree\` takes add <name>, remove <name> or ls.\n\n${USAGE}`,
			);
		}
		case "clone": {
			for (const line of await clone(cwd, rest)) console.log(line);
			return 0;
		}
		case "changed": {
			if (rest.length > 0) {
				throw new BasepadError(`\`basepad changed\` takes no arguments.\n\n${USAGE}`);
			}
			const selection = await changed({ cwd, base: values.base });
			console.error(`basepad: ${selection.summary}`);
			for (const project of selection.projects) console.log(project);
			return 0;
		}
		case "ci":
			return ci({ cwd, base: values.base, projects: rest, all: values.all });
		case "status": {
			const { table, warnings } = await status(cwd);
			for (const warning of warnings) console.error(warning);
			console.log(table);
			return 0;
		}
		default:
			throw new BasepadError(`Unknown command \`${command}\`.\n\n${USAGE}`);
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		if (
			error instanceof BasepadError ||
			(error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
		) {
			console.error(`basepad: ${(error as Error).message}`);
		} else {
			console.error(error);
		}
		process.exitCode = 1;
	},
);
