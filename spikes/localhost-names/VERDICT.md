# Spike: localhost names per worktree

**Verdict: mise's proxy (pitchfork).** It passes every criterion. It is already in the stack (basepad's daemons run under pitchfork), and it names worktrees itself. portless also works, but it needs a fresh-route wait, has no JSON output, and would be a second process manager.

## The prototype

`app/server.mjs` is one port serving `/`, `/other` and a websocket echo at `/ws`. A scratch repo `shop` with a linked worktree `pr-42` declares it as a daemon:

```toml
[settings]
experimental = true

[daemons.app]
run = "exec node /path/to/app/server.mjs $APP_PORT"
port = { auto = true, base = 4100 }
```

The proxy is configured in **pitchfork's own config**, `~/.config/pitchfork/config.toml` (or `/etc/pitchfork/config.toml`):

```toml
[settings.proxy]
enable = true
https = false
port = 8088
```

Each checkout then gets a name:

- `http://app.shop.localhost:8088` (primary checkout)
- `http://app.pr-42.shop.localhost:8088` (worktree)

Scripts:

- `mise-proxy.sh`: two worktrees, two routes and a websocket each, and a route listing.
- `next-hmr.sh`: `next dev` (16.4.5) as a daemon. It edits a page and waits for the HMR rebuild message through the proxy name.
- `portless.sh`: the same two names through portless 0.17.0.

## Results

| Criterion | mise's proxy (pitchfork 2.33.1) | portless 0.17.0 |
|---|---|---|
| Plain HTTP on a high port, no sudo | yes: `https = false`, `port = 8088` | yes: `proxy start --no-tls --port 8088` |
| Works as root | yes | yes |
| Works in CI (GitHub Actions) | yes: ubuntu:24.04 container as root, and macos-latest as a user | yes: both |
| Forwards websockets / Next HMR | yes, Next 16 HMR rebuild message received through the name | yes for websockets (echo) |
| Driven non-interactively | yes: the daemon config is the input, and `mise daemons start` routes it | yes: `portless alias <name> <port>`. **But the route isn't live when `alias` returns:** requests right after got `No app registered`, and a 2 s wait fixed it |
| Reports its routes | yes: `mise daemons ls --json` has `host`, `url`, `proxy`, `status` | text only: `portless list --json` prints the same table |
| Worktree naming | built in: `<daemon>.<worktree>.<project>.localhost` | prefix by hand, or its own worktree detection when it runs the command |

Local evidence (2026-11-09):

- mise's proxy:
  - on macOS 27 as a user: both names served both routes, with the websocket echo.
  - in ubuntu:24.04 as root: the same, plus Next HMR.
- portless: in ubuntu:24.04 as root.
- portless on macOS was not run locally. It came from CI.

CI evidence: a GitHub Actions workflow ran `mise-proxy.sh`, `portless.sh` and `next-hmr.sh` in an ubuntu:24.04 job container as root, and `mise-proxy.sh` and `portless.sh` on macos-latest. All five jobs were green. The logs show both names serving `/` and the websocket echo for every script, and the HMR `built` messages for `next-hmr.sh`.

## Findings basepad must act on

As recorded at spike time.

- **Put proxy settings in pitchfork's config file, not in env vars.** With `PITCHFORK_PROXY_*` env vars, any mise call made without them reports the wrong URL (`mise daemons urls` showed `https://…` with no port). Write `~/.config/pitchfork/config.toml` (as root, `/etc/pitchfork/config.toml`) once. A project's own `[settings.proxy]` is ignored.
- **Name resolution on minimal Linux:**
  - curl resolves `*.localhost` itself. Node (`getaddrinfo`) does not, and fails with `ENOTFOUND app.shop.localhost` in a local Docker ubuntu:24.04 container (no systemd-resolved). The same image as a GitHub Actions job container resolved fine, so this depends on the host's resolver. basepad can't assume either way.
  - As root, basepad writes a marked block of its names into `/etc/hosts`, as portless does.
  - macOS 26+ and systemd-resolved hosts need nothing.
- **Next needs no `allowedDevOrigins`.** Next 16 allows `**.localhost` origins for dev resources by default (`block-cross-site-dev.js`). A non-`.localhost` TLD would need it.
- **Next 16's HMR endpoint is `/_next/hmr?id=…`**, not `/_next/webpack-hmr`. This only matters for tests that probe HMR.
- **Presets don't get names.** basepad's shared services (Postgres, Mailpit) set `proxy = false` anyway.
- **Labels:** the worktree label is the worktree's directory name, overridable with `worktree_label` in a gitignored `pitchfork.local.toml`. Two names that fold to the same label are not routed at all.

## Not chosen: portless

- It's a second supervisor and route store (`~/.portless`) beside pitchfork.
- Its routes are registered by hand (`alias`), and aren't live straight after.
- It has no machine-readable route listing.
- It has known bugs: [routes file corrupted on kill](https://github.com/vercel-labs/portless/issues/382) and [two starts sharing a port](https://github.com/vercel-labs/portless/issues/533).
- It would be the fallback if pitchfork's proxy regressed, because aliasing ports works fine.
