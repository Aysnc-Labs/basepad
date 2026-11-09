# basepad

Local services for any project, native through [mise](https://mise.jdx.dev): Postgres, Neon's local proxy, Mailpit and Redis, shared across git worktrees, with no Docker. macOS and Linux.

Work in progress: today basepad adds a shared Postgres 18, with or without Neon's local proxy, and reports its status.

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
basepad add postgres-neon               # a database behind Neon's local proxy, for Neon's serverless driver
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

The state is mise's, as `mise daemons ls` reports it.

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
- One proxy serves every database on the shared Postgres, so every project and worktree uses the same `NEON_WS_PROXY`.
- `--name x` works as for `postgres`: `X_DATABASE_URL`. A project can't have both `postgres` and `postgres-neon` under their default names, since both write `DATABASE_URL`. `mise daemons tui` gives a live view.

### Presets

| Preset | Env file     | Variables                                                                                           |
| ------ | ------------ | --------------------------------------------------------------------------------------------------- |
| `next` | `.env.local` | `DATABASE_URL`, and `<NAME>_DATABASE_URL` for a named service; `NEON_WS_PROXY` with `postgres-neon` |

## How it works

- **The home project** is a mise project at `~/.local/share/basepad` (or `$XDG_DATA_HOME/basepad`, or `$BASEPAD_HOME`), with the daemon namespace `basepad`. It owns the shared daemons, so every project and worktree shares one Postgres. basepad writes and trusts it on first use. Its records, including the Postgres password, are in `basepad.json` there, readable by you only.
- **Postgres 18** comes from mise. Its cluster uses SCRAM passwords and a pinned `C.UTF-8` locale, listens on `127.0.0.1` only, and keeps its socket and data under the home project. Its port is the first free one from 54320, chosen once.
- **Neon's proxy** is Neon's own `proxy`, built from Neon's source and released by [aysnc-labs/mise-binaries](https://github.com/aysnc-labs/mise-binaries) as `neon-proxy`, pinned to `neon-proxy-fa50421`. While that repo is private, installing it needs `GITHUB_TOKEN` with read access to it. basepad starts it once Postgres accepts queries, on the first free ports from 54330. It serves plain WebSocket (no TLS, so no certificate to expire), and logs in to the maintenance database `postgres` as the superuser to look up roles, never to an app's database. It reads an allow-list from `neon_control_plane.endpoints` there, which basepad creates and leaves empty: no allow-list. Passwords are SCRAM, Postgres 18's default.
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

The tests run the built `basepad` command against real services (Postgres, mise and pitchfork) in temporary dirs on free ports. CI runs them on macOS as a user and on Ubuntu 24.04 as root. The `postgres-neon` tests download Neon's proxy from aysnc-labs/mise-binaries; while that repo is private, CI needs a `MISE_BINARIES_TOKEN` secret that can read it, and without one it skips those tests with a warning. Locally, export `GITHUB_TOKEN` (for example `GITHUB_TOKEN=$(gh auth token)`) the first time.

## License

MIT
