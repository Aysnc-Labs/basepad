#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { add } from "./internal/add.ts";
import { SERVICE_TYPES } from "./internal/config.ts";
import { BasepadError } from "./internal/exec.ts";
import { PRESETS } from "./internal/presets.ts";
import { status } from "./internal/status.ts";
import { up } from "./internal/up.ts";

const USAGE = `Usage: basepad <command>

Commands:
  add <service>... [--name <name>] [--preset <preset>]
                  Add services to this project's basepad.toml and start them
                  (services: ${SERVICE_TYPES.join(", ")}; presets: ${PRESETS.join(", ")})
  up              Start this project's services from basepad.toml and rewrite its env block
  status          List this project's services with their state, port and URL

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
			for (const line of await up(await realpath(cwd))) console.log(line);
			return 0;
		}
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
