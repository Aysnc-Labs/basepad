# basepad

Local services for any project, native through [mise](https://mise.jdx.dev): Postgres, Neon's local proxy, Mailpit and Redis, shared across git worktrees, with no Docker. macOS and Linux.

## Install

basepad needs mise 2026.10.24 or later and Node 24. Once it is published:

```sh
mise use -g npm:@aysnc-labs/basepad
```

Until then, run it from a checkout:

```sh
git clone https://github.com/Aysnc-Labs/basepad && cd basepad
mise install && npm ci && npm run build
alias basepad="node $PWD/dist/cli.js"
```

## Usage

In a project directory:

```sh
basepad add postgres                    # a database on the shared Postgres 18, as DATABASE_URL
basepad add postgres-neon               # a database behind Neon's local proxy, for Neon's serverless driver
basepad add mailpit                     # the shared mail catcher, as SMTP_URL, with an inbox in the browser
basepad add redis                       # the project's own Redis, as REDIS_URL
basepad add postgres mailpit redis      # several at once
basepad add postgres --name analytics   # a second database, as ANALYTICS_DATABASE_URL
basepad add redis --name cache          # a second Redis, as CACHE_URL
basepad add postgres --preset laravel   # choose the env file's preset (default: next)
basepad up                              # apply basepad.toml: start services, create databases, rewrite the env block
basepad status                          # every service: state, port, URL and localhost name
basepad worktree add feat-x             # a git worktree with its own databases, Redis, port and env block
basepad worktree ls                     # this repo's worktrees: state, ports and databases
basepad worktree remove feat-x          # undo all of it; the branch stays
basepad clone node_modules/.cache       # in a worktree: copy paths from main, copy-on-write
basepad changed                         # the projects this change touches, by basepad.toml's [ci] rules
basepad ci                              # run those projects' checks, as CI does
```

`basepad add`:

- declares the service in the project's `basepad.toml` (creating it), which you commit;
- starts the shared Postgres or Mailpit in basepad's home project, or the project's own Redis, if it isn't running, and waits until it's ready;
- creates the project's databases, named after the project's directory (plus the database's name when it isn't the default);
- writes `.config/mise/conf.d/basepad.toml`, so `mise daemons start` in the project starts its services too. It holds paths and ports on this machine, so don't commit it;
- writes the variables into a marked block of the preset's env file, and never touches anything outside the block:

  ```sh
  SECRET_KEY=your-own-variable

  # >>> basepad (written by basepad; edits inside this block are overwritten)
  DATABASE_URL=postgres://postgres:…@localhost:54320/shop
  SMTP_URL=smtp://shop:basepad@127.0.0.1:1025
  REDIS_URL=redis://127.0.0.1:63790
  # <<< basepad
  ```

Running it again is safe: it keeps the databases and rewrites only the block. After editing `basepad.toml`, run `basepad up`.

`basepad status` prints basepad's services, then the project's own mise daemons:

```
SERVICE        STATE    PORT   URL                                            NAME
app            running  8000   http://127.0.0.1:8000                          http://app.shop.localhost:8088
postgres       running  54320  postgres://postgres:***@localhost:54320/shop   -
mailpit        running  1025   smtp://shop:***@127.0.0.1:1025                 -
mailpit/inbox  running  8025   http://127.0.0.1:8025                          http://mail.basepad.localhost:8088
redis          running  63790  redis://127.0.0.1:63790                        -
web            running  4100   http://127.0.0.1:4100                          http://web.shop.localhost:8088
```

The state is mise's, as `mise daemons ls` reports it. `mise daemons tui` gives a live view.

### Services

| Service         | Runs                                                 | Variable                        | Worktrees get (default first) |
| --------------- | ---------------------------------------------------- | ------------------------------- | ----------------------------- |
| `postgres`      | Postgres 18, one shared server, a database each      | `DATABASE_URL`                  | `copy`, `empty`, `shared`     |
| `postgres-neon` | The same Postgres, behind one shared Neon proxy      | `DATABASE_URL`, `NEON_WS_PROXY` | `copy`, `empty`, `shared`     |
| `mailpit`       | Mailpit, one shared inbox, mail tagged per project   | `SMTP_URL`                      | `shared`                      |
| `redis`         | Redis 8, one per project or worktree, kept in memory | `REDIS_URL`                     | `empty`, `shared`             |

Mailpit tags each message with the SMTP username, and basepad's SMTP URL uses the project's directory name (letters, digits, `.`, `_` and `-`; anything else becomes `-`), so you can find a project's mail in the shared inbox with no change to your app. Mailpit accepts any password; basepad's is `basepad`.

### Neon's serverless driver

`basepad add postgres-neon` gives the project a database on the same shared Postgres, plus the shared Neon proxy in front of it, so [`@neondatabase/serverless`](https://github.com/neondatabase/serverless) talks to it over WebSocket as it does to Neon in production. It writes:

```sh
# >>> basepad (written by basepad; edits inside this block are overwritten)
DATABASE_URL=postgres://postgres:…@localhost:54320/shop?options=endpoint%3Dlocal
NEON_WS_PROXY=localhost:54330/v2
# <<< basepad
```

Point the driver at the proxy when `NEON_WS_PROXY` is set; nothing else changes:

```ts
import { neonConfig, Pool } from "@neondatabase/serverless";

if (process.env.NEON_WS_PROXY) {
	neonConfig.wsProxy = () => process.env.NEON_WS_PROXY!;
	neonConfig.useSecureWebSocket = false; // the local proxy serves plain ws://
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

- The host must be `localhost`: the proxy rejects IP addresses. It needs no DNS.
- `?options=endpoint%3Dlocal` names the Neon endpoint, which the proxy would otherwise read from TLS's server name. Keep it in the URL.
- Node 22 and later have a global `WebSocket`, so the driver needs no `ws` package.
- One proxy serves every database on the shared Postgres, so every project uses the same `NEON_WS_PROXY`, and `basepad status` lists it as `neon-proxy`. That name is reserved.
- Names and `databases` work as for `postgres`. A project can't have both under their default names, since both write `DATABASE_URL`.

### Configuration

`basepad.toml`, in the project's root:

```toml
preset = "next"                 # next or laravel

[app]
run = "npx next dev"            # your dev server, run as a daemon; it must listen on $PORT

[services.postgres]             # the service's name; its variables follow it
databases = ["app", "audit"]    # several databases: APP_DATABASE_URL and AUDIT_DATABASE_URL

[services.mail]
type = "mailpit"                # needed when the name isn't the service's type: MAIL_URL

[services.cache]
type = "redis"                  # CACHE_URL
copy = "shared"                 # worktrees use this project's Redis instead of their own

[rename]                        # the name basepad would write = the name you want
AUDIT_DATABASE_URL = "LOGS_DATABASE_URL"
```

- **Names:** a service named after its type gets the usual variable (`DATABASE_URL`, `SMTP_URL`, `REDIS_URL`). Any other name gets `<NAME>_URL`, or `<NAME>_DATABASE_URL` for Postgres. A Postgres service with `databases` gets `<DB>_DATABASE_URL` for each.
- **`copy`:** what each worktree gets of the service: a `copy` of the project's data, an `empty` one of its own, or the project's own, `shared`.
- **`rename`:** renames any variable basepad writes, after the preset's names.
- **`[app]`:** optional. basepad runs `run` as the mise daemon `basepad-app` on the app's port, which pitchfork passes as `PORT`, and serves it at the app's localhost name (see [Names](#names)). `basepad up` and `worktree add` start it; `worktree remove` stops it. `basepad-app` is reserved.

## Names

Each checkout's app, and the shared Mailpit inbox, answer at a stable localhost name, through [pitchfork's proxy](https://pitchfork.jdx.dev/reference/configuration), in plain HTTP on one port:

| Service           | Main checkout                        | Worktree `feat/x`                         |
| ----------------- | ------------------------------------ | ----------------------------------------- |
| the app           | `http://app.shop.localhost:8088`     | `http://app.feat-x.shop.localhost:8088`   |
| the Mailpit inbox | `http://mail.basepad.localhost:8088` | the same: one inbox, mail tagged `feat-x` |

- **The proxy:** basepad turns it on in pitchfork's user config, `~/.config/pitchfork/config.toml` (or `$PITCHFORK_CONFIG_DIR/config.toml`), with `enable = true`, `https = false` and `port = 8088`, unless that file or `/etc/pitchfork/config.toml` already says whether it's on. Settings you already have, such as the port, are kept. A project's own `[settings.proxy]` is ignored by pitchfork. pitchfork's supervisor reads these once: if it was already running without the proxy, basepad says so; restart it with `mise exec pitchfork@2.33.1 -- pitchfork supervisor start --force` (which stops running daemons), then run `basepad up`.
- **Labels:** `shop` is main's directory name. A worktree's label is its name, lowercased, with anything but letters, digits and `-` turned into `-`, and `-2`, `-3` and so on when another worktree of the repo already has it. basepad writes it as `worktree_label` in the worktree's `pitchfork.local.toml`, so gitignore that file. Two repos whose main directories share a name share names too, and pitchfork routes neither.
- **Your own daemons** with a `port` get names too (`web` above), unless they set `proxy = false`.
- **Resolving names:** browsers and curl resolve `*.localhost` themselves, and so do macOS and Linux with systemd-resolved. Where the system doesn't (a minimal container), basepad, when it runs as root, writes its names into a marked block of `/etc/hosts`, `# >>> basepad names (<home>)`, and keeps it in step as worktrees come and go. Not as root, it prints the line to add.
- **Hot reload** goes through the name: the proxy forwards websockets, and Next's dev server already allows `*.localhost` origins, so it needs no `allowedDevOrigins`.
- **Databases, Redis and SMTP** keep `localhost` or `127.0.0.1` and a port: names cover HTTP services only.

### Presets

| Preset    | Env file     | Variables                                                                                                                                                                                         |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next`    | `.env.local` | basepad's own names                                                                                                                                                                               |
| `laravel` | `.env`       | `DB_CONNECTION=pgsql` and `DB_URL` for `DATABASE_URL`; `MAIL_MAILER=smtp`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME` and `MAIL_PASSWORD` for `SMTP_URL`; `REDIS_URL`; `APP_URL` and `SERVER_PORT` |

Laravel reads `.env` itself, not the shell, and the last line for a variable wins, so basepad's block, at the end of the file, overrides the defaults above it. `APP_URL` uses a free port basepad picks for the project, from 8000, and `SERVER_PORT` makes `php artisan serve` use it. If you serve the app another way (Herd, say), rename them out of the way:

```toml
[rename]
APP_URL = "BASEPAD_APP_URL"
SERVER_PORT = "BASEPAD_SERVER_PORT"
```

`REDIS_URL` has no database index, so Laravel's default and cache connections keep their own (`REDIS_DB`, `REDIS_CACHE_DB`).

### A Laravel app

```sh
basepad add postgres mailpit redis --preset laravel
php artisan migrate
```

Add a `basepad:post-create` hook, a mise task in your `mise.toml`, for the setup a new worktree needs:

```toml
[tasks."basepad:post-create"]
run = ["composer install", "php artisan migrate --seed"]
```

basepad runs it after it creates a worktree; see [Worktrees](#worktrees).

## Worktrees

`basepad worktree add <name>`, run anywhere in the repo, gives a ready worktree in seconds:

1. `git worktree add`: branch `<name>`, new from main's `HEAD` unless it exists, checked out beside main as `<main>-<name>` (`feat/x` becomes `<main>-feat-x`), or at `--path <dir>`.
2. Copies the files listed in `.worktreeinclude`, in main's root, that git ignores (`.env` files, caches), as copy-on-write clones where the filesystem supports them (APFS, Btrfs, XFS), else plain copies. It's [Claude Code's convention](https://code.claude.com/docs/en/worktrees): gitignore syntax, and tracked files come with the checkout anyway.
3. Brings main up, then the worktree, each service as its `copy` strategy says:
   - **Postgres, `copy`** (the default): `<main's database>_<worktree>`, e.g. `shop_feat_x`, made with `CREATE DATABASE … TEMPLATE` from main's. Postgres refuses a template that anyone is connected to, so when main's database is in use (your dev server, a `psql`), basepad dumps and restores it instead. Main is never interrupted.
   - **Postgres, `empty`**: `<main's database>_<worktree>`, empty. **`shared`**: main's own.
   - **Redis, `empty`** (the default): the worktree's own, on a new port. **`shared`**: main's.
   - **Mailpit**: shared, with the worktree's name as the SMTP username, so its mail is tagged with it.
4. Picks a free port for the app (from 8000), records it, and writes it as `PORT` (`SERVER_PORT` and `APP_URL` with the `laravel` preset).
5. Writes the worktree's env block, and its label for [names](#names).
6. Runs the project's `basepad:post-create` task, then `basepad:post-start`.
7. Starts the app, with `[app]`, and waits up to 30 s for it to listen and for its name to answer.

`basepad up` in a worktree brings it back up and runs `basepad:post-start` again. `basepad worktree remove <name>` runs `basepad:pre-remove`, stops the worktree's app and its own services, drops its own databases (`WITH (FORCE)`), clears its env block and basepad's records of it, and removes the worktree. Its branch stays. It refuses a worktree with uncommitted changes, or whose `basepad:pre-remove` fails, unless you pass `--force`.

```
$ basepad worktree ls
WORKTREE  STATE    PORT  REDIS  DATABASES    PATH
feat-x    serving  8000  63791  shop_feat_x  /Users/me/code/shop-feat-x
feat-y    ready    8001  63792  shop_feat_y  /Users/me/code/shop-feat-y
```

`serving` means something listens on the worktree's app port; `missing`, that its directory is gone (`basepad worktree remove` still cleans up after it).

### Hooks

Hooks are mise tasks in your project, so basepad stays stack-agnostic: installs, migrations and caches are yours. basepad runs each one in the worktree's project directory, if it's defined:

| Task                  | When                                                    |
| --------------------- | ------------------------------------------------------- |
| `basepad:post-create` | after `worktree add` has made the worktree and its data |
| `basepad:post-start`  | after `worktree add`, and after `basepad up` in it      |
| `basepad:pre-remove`  | first thing in `worktree remove`                        |

They see the worktree's env block (every service's URL, under the names your app reads, and `PORT`) and:

| Variable                | Value               |
| ----------------------- | ------------------- |
| `BASEPAD_WORKTREE`      | the worktree's name |
| `BASEPAD_WORKTREE_PATH` | the worktree's root |
| `BASEPAD_MAIN_PATH`     | main's root         |

Their output goes to stderr. `basepad clone <path>…` copies paths from main into the worktree, at the same place, copy-on-write where it can; paths are relative to where you run it:

```toml
[tasks."basepad:post-create"]
run = ["pnpm install --offline --frozen-lockfile", "basepad clone .next/cache"]
```

An offline install from pnpm's store is faster than cloning `node_modules`, so install rather than clone it.

## Claude Code

basepad can make the worktrees Claude Code works in (`claude --worktree feat-x`, subagents with `isolation: "worktree"`, background sessions), so each one comes with its own databases, Redis, port and env block. It's your choice, per project: wire the [`WorktreeCreate` and `WorktreeRemove` hooks](https://code.claude.com/docs/en/hooks#worktreecreate) in the project's `.claude/settings.json`:

```json
{
	"hooks": {
		"WorktreeCreate": [
			{ "hooks": [{ "type": "command", "command": "basepad worktree add --claude" }] }
		],
		"WorktreeRemove": [
			{ "hooks": [{ "type": "command", "command": "basepad worktree remove --claude" }] }
		]
	}
}
```

- `worktree add --claude` reads the hook's input on stdin, makes worktree `name` from the session's `cwd` as `worktree add <name>` does, and prints the worktree's absolute path as the only line on stdout, as Claude Code expects. Everything else, your hooks' output included, goes to stderr. If anything fails, it exits non-zero and Claude Code doesn't start the session there.
- Claude Code stops applying `.worktreeinclude` once the hook is set; basepad applies it itself.
- `worktree remove --claude` removes the worktree at the input's `worktree_path`, as `worktree remove --force` does: Claude Code only removes a worktree once it has asked, or found nothing to lose. Then it deletes the worktree's branch, unless the branch has commits that main's checkout doesn't have; basepad keeps that branch and says so, since Claude Code never deletes it.
- Neither runs for a `git worktree add` you type yourself; use `basepad worktree add` for those.

## Shared tasks

basepad publishes mise tasks every project can include instead of copying: `status`, `changed`, `ci` and `bootstrap`. Add basepad's to your mise config's `[task_config] includes`, pinned to a release tag:

```toml
[task_config]
includes = [
  "mise-tasks", # your own task dir: listing includes replaces mise's defaults, so keep yours here
  "git::https://github.com/aysnc-labs/basepad.git//tasks?ref=<tag>",
]
```

Replace `<tag>` with the release you use. A task of your own with the same name, listed after basepad's, wins. mise caches the clone, so a pinned tag is fetched once. If your project already lists `includes`, add basepad's line to that list: mise uses only the highest-precedence list, never a merge ([task discovery](https://mise.jdx.dev/tasks/task-discovery.html)).

| Task        | Runs                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `status`    | `basepad status`                                                                            |
| `changed`   | `basepad changed`: the projects this change touches                                         |
| `ci`        | `basepad ci`: those projects' checks, exactly as CI runs them                               |
| `bootstrap` | in a cloud session, the project's tools and services; see [Cloud sessions](#cloud-sessions) |

Each needs `basepad` on `PATH`, for example from the project's own `[tools]`.

### changed and ci

Describe the repo's projects in a `[ci]` table of the `basepad.toml` at the repo's root:

```toml
[ci]
all = ["pnpm-lock.yaml", "mise.toml", ".github/**"] # a change here selects every project
# base = "origin/develop"                           # what a local run compares with

[ci.projects.web]
paths = ["apps/web", "packages/ui/**"]             # a plain path covers everything under it
run = "pnpm --filter web check"

[ci.projects.docs]
paths = ["docs/**/*.md"]
run = ["pnpm --filter docs build", "pnpm --filter docs test"]
```

`basepad changed` prints the projects whose `paths` the change touches, one per line in the config's order, or every project when a path in `all` changed. The change is every file that differs from the merge-base of `HEAD` and the base, plus uncommitted and untracked files, counting both sides of a rename. The base is:

1. `--base <ref>`, if given;
2. in GitHub Actions, the pull request's base, the merge queue's base, or the push's previous commit (`before`);
3. otherwise `[ci] base`, else origin's default branch (`origin/HEAD`), else `origin/main`, else `main`.

When the base isn't in the clone, a shallow checkout say, it selects every project and says why. Fetch the history in CI:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- run: mise run ci
```

`basepad ci` runs each selected project's `run` commands with `sh`, from the repo's root, one project after another. A project stops at its first failing command; the other projects still run, and `ci` exits non-zero if any failed. `basepad ci web docs` runs the named projects, and `basepad ci --all` runs them all. Locally, `mise run ci` runs what CI would for your branch.

## Cloud sessions

A [Claude Code cloud session](https://code.claude.com/docs/en/cloud-environments) runs as root on a fresh Ubuntu 24.04 VM, keeps the files its setup script writes for about seven days, and keeps no processes. So the setup script installs the tools once, and a `SessionStart` hook starts the services in every session. basepad runs as root: Postgres runs as the system user `basepad`.

1. Commit a setup file, `scripts/cloud-setup.sh`, that installs mise and your tools:

   ```bash
   #!/usr/bin/env bash
   # Run by the cloud environment's setup script, as root, before Claude Code starts.
   set -euo pipefail
   cd "$(dirname "$0")/.."
   export PATH="$HOME/.local/bin:$PATH"
   command -v mise >/dev/null || curl -fsSL https://mise.run | MISE_VERSION=v2026.11.5 sh
   mise trust --yes
   mise install
   mise tasks ls >/dev/null # fetches the shared tasks, so the environment cache keeps them
   ```

2. In the environment's settings on [claude.ai/code](https://claude.ai/code), make the setup script run only that file, so everything else lives in the repo:

   ```bash
   bash scripts/cloud-setup.sh
   ```

3. Start the services from a `SessionStart` hook in the project's `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "matcher": "startup|resume",
           "hooks": [{ "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR\" && \"$HOME/.local/bin/mise\" run --quiet bootstrap" }]
         }
       ]
     }
   }
   ```

   `bootstrap` does nothing unless `CLAUDE_CODE_REMOTE` is `true`, so the hook is harmless on a laptop. In a cloud session it runs `mise install`, then `basepad up --background`: it returns at once, while basepad starts the services and writes the env block, logging to `logs/up-<project>.log` in basepad's home. Claude sees its one line of output, which says to check `basepad status`.

4. Allow the downloads. This is the one manual step: in the environment's **Network access**, choose **Custom**, keep **Also include default list of common package managers** checked, and add one domain per line:

   ```text
   mise.run
   mise.jdx.dev
   mise-versions.jdx.dev
   ```

   The default list already covers the rest basepad downloads from: conda-forge (`conda.anaconda.org`, for Postgres and Redis), GitHub releases (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, for pitchfork, Mailpit and Neon's proxy), Node (`nodejs.org`) and npm (`registry.npmjs.org`). With the default list unchecked, add those too.

## How it works

- **The home project** is a mise project at `~/.local/share/basepad` (or `$XDG_DATA_HOME/basepad`, or `$BASEPAD_HOME`), with the daemon namespace `basepad`. It owns the shared daemons, so every project and worktree shares one Postgres, one Neon proxy and one Mailpit. basepad writes and trusts it on first use. Its records, including the Postgres password, are in `basepad.json` there, readable by you only.
- **Postgres 18** comes from mise. Its cluster uses SCRAM passwords and a pinned `C.UTF-8` locale, listens on `127.0.0.1` only, and keeps its socket and data under the home project. Its port is the first free one from 54320, chosen once.
- **Mailpit** comes from its GitHub releases, through mise. It listens on `127.0.0.1` only, on the first free ports from 1025 (SMTP) and 8025 (inbox), and keeps its messages in a file under the home project.
- **Redis 8** comes from mise. Each project runs its own, from its conf.d file, on the first free port from 63790, listening on `127.0.0.1` and keeping nothing on disk.
- **Neon's proxy** is Neon's own `proxy`, built from Neon's source and released by [aysnc-labs/mise-binaries](https://github.com/aysnc-labs/mise-binaries) as `neon-proxy`, pinned to `neon-proxy-fa50421`. While that repo is private, installing it needs `GITHUB_TOKEN` with read access to it. basepad starts it once Postgres accepts queries, on the first free ports from 54330. It serves plain WebSocket (no TLS, so no certificate to expire), and logs in to the maintenance database `postgres` as the superuser to look up roles, never to an app's database. It reads an allow-list from `neon_control_plane.endpoints` there, which basepad creates and leaves empty: no allow-list. Passwords are SCRAM, Postgres 18's default.
- **As root** (cloud containers), Postgres runs as the unprivileged system user `basepad`, which basepad creates. mise installs under `/root`, so basepad grants that user traverse-only access (`o+x`) to the directories above Postgres's binaries and data.
- **mise's variables:** projects reference the shared daemons rather than declaring them, so mise exports no `<NAME>_URL` or `<NAME>_PORT` for them. For a project's own daemons, mise exports `<DAEMON>_PORT` (and `<DAEMON>_URL` when named) into the shell: the app's daemon is `basepad-app`, so it gets `BASEPAD_APP_URL` and `BASEPAD_APP_PORT`, never your `APP_URL`. basepad's env block is the source for your app.
- **Pinned:** the configs basepad writes require mise 2026.10.24 or later and pin pitchfork 2.33.1.
- **Trust:** basepad trusts only the home project, which it writes. mise trusts a worktree's config when main's is trusted, unless [paranoid mode](https://mise.jdx.dev/paranoid.html) is on. If your project's mise config isn't trusted, `basepad add` still works; review it and run `mise trust` before `mise daemons start`, or for `basepad status` to list your own daemons.

### A separate basepad

To run a basepad that shares nothing with your everyday one, point basepad, mise and pitchfork at their own state:

```sh
export BASEPAD_HOME=/tmp/bp/home MISE_STATE_DIR=/tmp/bp/mise-state MISE_CONFIG_DIR=/tmp/bp/mise-config
export PITCHFORK_STATE_DIR=/tmp/bp/pf-state PITCHFORK_CONFIG_DIR=/tmp/bp/pf-config PITCHFORK_LOGS_DIR=/tmp/bp/pf-logs
```

## Development

```sh
mise install && npm ci
npm run check
```

The tests run the built `basepad` command against real services (Postgres, Mailpit, Redis, mise and pitchfork) in temporary dirs on free ports. CI runs them on macOS as a user and on Ubuntu 24.04 as root. The `postgres-neon` tests download Neon's proxy from aysnc-labs/mise-binaries; while that repo is private, CI needs a `MISE_BINARIES_TOKEN` secret that can read it, and without one it skips those tests with a warning. Locally, export `GITHUB_TOKEN` (for example `GITHUB_TOKEN=$(gh auth token)`) the first time.

## License

MIT
