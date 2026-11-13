# Feature map

Per feature: what it does for its users, and where it starts.

## The config contract

A project describes everything it wants in one committed `basepad.config.ts`: its `name`, services, apps and env files. `defineConfig` types it, so the editor completes keys and `env` sees only the outputs the config declares; `postgres()` makes a Postgres service (17 or 18, default 18).

Starts at: `src/index.ts` (the package's export).

## Loading the config

Finds `basepad.config.ts` in the current folder or the nearest one above, loads it as TypeScript ESM whatever `package.json` says about module type, applies `basepad.config.local.ts` over it when present, and validates. Every failure names the file, and the key at fault.

Starts at: `loadProject` in `src/config.ts`.

## Layout

Derives every name from the project's description: each app's domain `<app>.<name>.localhost` and each service's database `<name>_<service>`. Rejects a name past its limit (63-character domain label, 63-byte database name) with the reason, never truncating.

Starts at: `layout` in `src/layout.ts`.

## The `basepad` command

Checks that mise is at least `MISE_MIN_VERSION`, then runs basepad on the current Node when it is 24 or newer, else again on mise's Node 24. Dispatches commands, and generates `--help`, from one table; a mistyped command or flag names the nearest one.

Starts at: `src/launcher.ts` (the bin), then `src/cli.ts`; commands are declared in `COMMANDS` in `src/commands.ts`. Tool versions live in `src/versions.ts`.

## `basepad init`

Writes a starter `basepad.config.ts` named from the folder, adds `basepad.config.local.ts` to `.gitignore`, and adds basepad as a devDependency when `package.json` lacks it. Refuses to overwrite an existing config.

Starts at: `init` in `src/commands.ts`.

## `basepad status`

Prints one row per app with its URL and state. Nothing is started yet, so every app shows `stopped`.

Starts at: `status` in `src/commands.ts`.
