# basepad

Local services for any project, native through [mise](https://mise.jdx.dev): Postgres, Neon's local proxy, Mailpit and Redis, shared across git worktrees, with no Docker. macOS and Linux.

Work in progress: today basepad adds a shared Postgres 18 and reports its status.

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
basepad add postgres --name analytics   # a second database, as ANALYTICS_DATABASE_URL
basepad add postgres --preset next      # choose the env file's preset (default: next)
basepad status                          # every service: state, port and URL
```

`basepad add postgres`:

- starts the shared Postgres in basepad's home project, if it isn't running, and waits until it accepts queries;
- creates the project's database, named after the project's directory (plus the service's name when you pass `--name`);
- writes `.config/mise/conf.d/basepad.toml`, which references the shared daemon, so `mise daemons start` in the project starts it too;
- writes the variables into a marked block of the preset's env file, and never touches anything outside the block:

  ```sh
  SECRET_KEY=your-own-variable

  # >>> basepad (written by basepad; edits inside this block are overwritten)
  DATABASE_URL=postgres://postgres:…@localhost:54320/shop
  # <<< basepad
  ```

Running it again is safe: it keeps the database and rewrites only the block.

`basepad status` prints basepad's services, then the project's own mise daemons:

```
SERVICE   STATE    PORT   URL
postgres  running  54320  postgres://postgres:***@localhost:54320/shop
web       running  4100   https://web.shop.localhost
```

The state is mise's, as `mise daemons ls` reports it. `mise daemons tui` gives a live view.

### Presets

| Preset | Env file | Variables |
|---|---|---|
| `next` | `.env.local` | `DATABASE_URL`, and `<NAME>_DATABASE_URL` for a named service |

## How it works

- **The home project** is a mise project at `~/.local/share/basepad` (or `$XDG_DATA_HOME/basepad`, or `$BASEPAD_HOME`), with the daemon namespace `basepad`. It owns the shared daemons, so every project and worktree shares one Postgres. basepad writes and trusts it on first use. Its records, including the Postgres password, are in `basepad.json` there, readable by you only.
- **Postgres 18** comes from mise. Its cluster uses SCRAM passwords and a pinned `C.UTF-8` locale, listens on `127.0.0.1` only, and keeps its socket and data under the home project. Its port is the first free one from 54320, chosen once.
- **As root** (cloud containers), Postgres runs as the unprivileged system user `basepad`, which basepad creates. mise installs under `/root`, so basepad grants that user traverse-only access (`o+x`) to the directories above Postgres's binaries and data.
- **No mise variables:** every basepad daemon sets `proxy = false`, and projects reference daemons rather than declaring them, so mise exports no `<NAME>_URL` or `<NAME>_PORT` of its own. basepad's env block is the one source.
- **Pinned:** the configs basepad writes require mise 2026.10.24 or later and pin pitchfork 2.33.1.
- **Trust:** basepad trusts only the home project, which it writes. If your project's mise config isn't trusted, `basepad add` still works; review it and run `mise trust` before `mise daemons start`, or for `basepad status` to list your own daemons.

### A separate basepad

To run a basepad that shares nothing with your everyday one, point basepad, mise and pitchfork at their own state:

```sh
export BASEPAD_HOME=/tmp/bp/home MISE_STATE_DIR=/tmp/bp/mise-state MISE_CONFIG_DIR=/tmp/bp/mise-config
export PITCHFORK_STATE_DIR=/tmp/bp/pf-state PITCHFORK_CONFIG_DIR=/tmp/bp/pf-config PITCHFORK_LOGS_DIR=/tmp/bp/pf-logs
```

The tests do exactly this, one temporary machine per test file.

## Development

```sh
mise install && npm ci
npm run check   # Biome, TypeScript, then the CLI tests
```

The tests run the built `basepad` command against real services (Postgres, mise and pitchfork) in temporary dirs on free ports. CI runs them on macOS as a user and on Ubuntu 24.04 as root.

## License

MIT
