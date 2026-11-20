# basepad

## 0.3.0

### Minor Changes

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`bacfe35`](https://github.com/Aysnc-Labs/basepad/commit/bacfe353ab0cff606ece740e5bbfc6f5f14d6c20) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Apps run through mise in their checkout, so `php artisan serve` uses the PHP your `mise.toml` pins even when Homebrew's comes first on `PATH`, and an app in a worktree uses the worktree's tools. The variables basepad gives an app or hook (`PORT`, the env files' keys, `BASEPAD_*`) win over the checkout's `mise.toml` `[env]`. Before any hook or app runs, `basepad up` checks that mise trusts the checkout's config, even in a project with no services: an untrusted `mise.toml` fails with mise's error and the `mise trust` command, and basepad never trusts it for you.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`f742f7e`](https://github.com/Aysnc-Labs/basepad/commit/f742f7e23d09465c10399483b5068ec204f6c793) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Run hooks around the `db` commands: `beforeSave`/`afterSave`, `beforeLoad`/`afterLoad`, `beforeDelete`/`afterDelete` (`db rm`), `beforeImport`/`afterImport` and `beforeExport`/`afterExport`, with `BASEPAD_SERVICE` and the command's `BASEPAD_LABEL`, `BASEPAD_SOURCE` or `BASEPAD_FILE`. A `before…` hook runs only once the command is checked (and, for `import`, confirmed), and cancels it if it fails; a failed `after…` hook exits 1 and keeps the work. With `db export` to standard output, hook output goes to standard error.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`41097c3`](https://github.com/Aysnc-Labs/basepad/commit/41097c3d96cc271646189c3437c72dcc128f0af8) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Add `hooks` to the config: shell commands run around events that change an environment. `basepad up` runs `beforeUp` once services are ready and env files written, and `afterUp` once the apps have started; `basepad down` runs `beforeDown` and `afterDown` around stopping. Hooks run through mise in the environment's checkout, with stdin closed, the env files' keys (each one `env` declares that is a shell name is set, empty when its file or key is absent, so it overrides your shell and mise's `[env]`), `BASEPAD_EVENT` and `BASEPAD_ENVIRONMENT`; an `env` that throws when basepad reads its keys gets a warning that hooks get none. A failed `beforeUp` cancels `up`, a failed `afterUp` makes it exit 1 with the apps running, and failed Down hooks only warn. A hook runs only in a checkout whose `mise.toml` mise trusts: an untrusted one fails `up` with mise's error, and `down` skips its Down hooks with that error and still stops everything. Mission control shows hook output as a `hooks` log row.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`93914f8`](https://github.com/Aysnc-Labs/basepad/commit/93914f87cac9a20b085d96ec3224e9b47894c1ec) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Postgres and Neon's proxy now come from your project's `mise.toml`: `basepad up` runs `mise install` and `mise which` in main's checkout and runs those programs, so the `psql` in your terminal is the server's build. A project without them gets the lines to add (prebuilt Postgres `18.7-3` with pgvector and PostGIS, and `neon-proxy` `8853-1`); an untrusted `mise.toml` gets mise's error and the `mise trust` command. `postgres({ version })` and `postgresWithNeonProxy({ version })` are removed and rejected as an unknown key: the Postgres build in `mise.toml` decides the version, read from `postgres --version`. The `PostgresVersion` type is removed. basepad no longer copies pgvector in from conda; extensions come with the build.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`35f7b85`](https://github.com/Aysnc-Labs/basepad/commit/35f7b85201bf09ffd8f5a3804906fdc790dde970) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Redis and Mailpit now come from your project's `mise.toml`, as Postgres does: basepad no longer installs `redis@8` or `mailpit@1` itself. A worktree's own Redis runs the `redis-server` of the worktree's `mise.toml`; main's Redis, `redis({ worktree: "shared" })` and Mailpit run main's. A project without them gets the lines to add: prebuilt `redis = "8.10.3-1"` and `mailpit = "1.33.1"`.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`f419bb7`](https://github.com/Aysnc-Labs/basepad/commit/f419bb7eff124877546e8008cac303a116a6cb64) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Remove `basepad init`. Write `basepad.config.ts` by hand (the guide's "A first project" shows one), add `basepad.config.local.ts` to `.gitignore` and install basepad as a devDependency. Running basepad without a config now links to the guide.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`ef80282`](https://github.com/Aysnc-Labs/basepad/commit/ef80282199e1f67708815ad3a710e378d33a4e44) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Run Create and Remove hooks. `beforeCreate` and `afterCreate` run in a new worktree, from `worktree add` or the first `basepad up` in a git worktree made by hand: `beforeCreate` before its databases and env files are made, `afterCreate` once they are, before `--start`'s apps. A failure exits 1 and keeps the worktree. `beforeRemove` and `afterRemove` come from main's config and run from main's folder around `worktree rm` and for each worktree `prune` clears, with `BASEPAD_WORKTREE`; their failures only warn. Breaking: `worktrees.setup` is gone and rejected as an unknown key; move its commands to `hooks.afterCreate`.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`e07131b`](https://github.com/Aysnc-Labs/basepad/commit/e07131b9f8f5901d142c072fb18a8788290bc708) Thanks [@junaidbhura](https://github.com/junaidbhura)! - A worktree whose `mise.toml` resolves a different program than main's for a service on main's servers (Postgres, its Neon proxy, Mailpit, a shared Redis) now fails `up` and `worktree add` there, naming both paths, instead of running mismatched tools against main's server. `down` and `status` in it still work.

### Patch Changes

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`1a37acd`](https://github.com/Aysnc-Labs/basepad/commit/1a37acdef58edb7d3b6030d60f0fd5870b9c67b8) Thanks [@junaidbhura](https://github.com/junaidbhura)! - On a project whose Node is older than 24, `npx basepad` no longer makes mise trust the project's `mise.toml`: it starts Node 24 from basepad's home folder.

- [#67](https://github.com/Aysnc-Labs/basepad/pull/67) [`28ed415`](https://github.com/Aysnc-Labs/basepad/commit/28ed4153cdf5c270e63b9e4dfe3fbf8f8412cbf5) Thanks [@junaidbhura](https://github.com/junaidbhura)! - A service that can't start names its program's path, and the glibc advice knows Debian 13 (2.41) and Ubuntu 26.04 (2.43).

## 0.2.0

### Minor Changes

- [#50](https://github.com/Aysnc-Labs/basepad/pull/50) [`1327bee`](https://github.com/Aysnc-Labs/basepad/commit/1327beed2ec3dd71bed8db476438333d194acd06) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Add `postgresWithNeonProxy()`: basepad's Postgres with Neon's local proxy in front of it, so `@neondatabase/serverless` connects locally through `url` and `wsProxy`, with `directUrl` for every other tool. `status` and mission control list the proxy as `<key>-neon-proxy`, and stopping or starting the service stops or starts its proxy too; `up` and `prune` stop a proxy the config no longer asks for. On Linux it needs glibc 2.39 or newer, and `up` says so on an older one.

### Patch Changes

- [#50](https://github.com/Aysnc-Labs/basepad/pull/50) [`89a71b4`](https://github.com/Aysnc-Labs/basepad/commit/89a71b45dbf131780c9aa78cf6d82881b9f65153) Thanks [@junaidbhura](https://github.com/junaidbhura)! - `up` sets a key written empty in an env file (`KEY=`) on its own line, instead of putting the value on the line after it.

- [#50](https://github.com/Aysnc-Labs/basepad/pull/50) [`31fa397`](https://github.com/Aysnc-Labs/basepad/commit/31fa39739630c875c036af27fc44652fe64cf535) Thanks [@junaidbhura](https://github.com/junaidbhura)! - The `postgres` role of every Postgres service now has the password `basepad`, stored as SCRAM, so the password in `url` is real. Local connections still need none; an existing server gets it on its next `basepad up`.

- [#50](https://github.com/Aysnc-Labs/basepad/pull/50) [`19ea37a`](https://github.com/Aysnc-Labs/basepad/commit/19ea37ab57ca86ba46b7af187db7ec7d7bbd0536) Thanks [@junaidbhura](https://github.com/junaidbhura)! - As root on Linux, basepads that start Postgres at the same moment no longer fail with `initdb: could not look up effective user ID … user does not exist`: the `basepad` system user is now created under a lock.

## 0.1.1

### Patch Changes

- [#42](https://github.com/Aysnc-Labs/basepad/pull/42) [`b1e2d0c`](https://github.com/Aysnc-Labs/basepad/commit/b1e2d0c57ab74eb16290a720003ab623f2139eff) Thanks [@junaidbhura](https://github.com/junaidbhura)! - On Linux, `basepad setup` trusts basepad's CA in Chrome's NSS store at `~/.local/share/pki/nssdb`, where Chrome 146 and later keep it when there is no `~/.pki/nssdb`.

- [#42](https://github.com/Aysnc-Labs/basepad/pull/42) [`b1e2d0c`](https://github.com/Aysnc-Labs/basepad/commit/b1e2d0c57ab74eb16290a720003ab623f2139eff) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Mission control no longer crashes when it reads a worktree job in the moment the job starts.

- [#42](https://github.com/Aysnc-Labs/basepad/pull/42) [`519f666`](https://github.com/Aysnc-Labs/basepad/commit/519f66652ba1c35c0cff1cd25212612b874c21eb) Thanks [@junaidbhura](https://github.com/junaidbhura)! - A failed `db import` from a `postgres://` URL now says `` `pg_dump | pg_restore` failed (exit N) `` before the error.

## 0.1.0

### Minor Changes

- [`e9b0071`](https://github.com/Aysnc-Labs/basepad/commit/e9b007178d1c2804c6fdebdf2b7a6f6ce8761d24) Thanks [@junaidbhura](https://github.com/junaidbhura)! - First release: a development environment for coding agents.
