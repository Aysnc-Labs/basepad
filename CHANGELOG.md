# basepad

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
