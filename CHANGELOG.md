# basepad

## 0.1.1

### Patch Changes

- [#42](https://github.com/Aysnc-Labs/basepad/pull/42) [`b1e2d0c`](https://github.com/Aysnc-Labs/basepad/commit/b1e2d0c57ab74eb16290a720003ab623f2139eff) Thanks [@junaidbhura](https://github.com/junaidbhura)! - On Linux, `basepad setup` trusts basepad's CA in Chrome's NSS store at `~/.local/share/pki/nssdb`, where Chrome 146 and later keep it when there is no `~/.pki/nssdb`.

- [#42](https://github.com/Aysnc-Labs/basepad/pull/42) [`b1e2d0c`](https://github.com/Aysnc-Labs/basepad/commit/b1e2d0c57ab74eb16290a720003ab623f2139eff) Thanks [@junaidbhura](https://github.com/junaidbhura)! - Mission control no longer crashes when it reads a worktree job in the moment the job starts.

- [#42](https://github.com/Aysnc-Labs/basepad/pull/42) [`519f666`](https://github.com/Aysnc-Labs/basepad/commit/519f66652ba1c35c0cff1cd25212612b874c21eb) Thanks [@junaidbhura](https://github.com/junaidbhura)! - A failed `db import` from a `postgres://` URL now says `` `pg_dump | pg_restore` failed (exit N) `` before the error.

## 0.1.0

### Minor Changes

- [`e9b0071`](https://github.com/Aysnc-Labs/basepad/commit/e9b007178d1c2804c6fdebdf2b7a6f6ce8761d24) Thanks [@junaidbhura](https://github.com/junaidbhura)! - First release: a development environment for coding agents.
