# Spike: native Postgres 18 and Neon's proxy

**Verdict: go.** The whole stack runs natively, with no Docker and no Caddy:

- Postgres 18 from mise (conda backend) runs on macOS as the user, and on Linux as root through an unprivileged system user.
- Neon's `proxy`, built from upstream source, serves plain WebSocket, so it needs no TLS and has no certificate to expire.
- One proxy serves every database on the server.
- `@neondatabase/serverless`'s `Pool` connects with a `localhost` URL and no DNS.

## Run it

```sh
# macOS, as a user
PROXY_BIN=/path/to/darwin/proxy PGPORT=55432 WSS_PORT=54444 \
  PGQUERY='?options=endpoint%3Dlocal' ./stack.sh

# Linux, as root
docker run --rm -e PGQUERY='?options=endpoint%3Dlocal' \
  -v "$PWD:/spike" -v /path/to/linux/proxy:/proxy ubuntu:24.04 /spike/stack.sh
```

`stack.sh` does the following:

1. Installs Postgres 18 and Node 24 through mise.
2. Runs `initdb` with SCRAM, and starts Postgres.
3. Creates two databases, each with a table.
4. Starts the proxy against the maintenance database.
5. Runs `two-dbs.mjs`, which queries both databases through the driver.

Expected output:

```
[{"db":"alpha","name":"alpha row"}]
[{"db":"beta","name":"beta row"}]
```

## Evidence (2026-11-09)

| Platform | Postgres | Proxy binary | Result |
|---|---|---|---|
| macOS 27 arm64, as a user | 18.6 (conda) | darwin-arm64 | both databases queried |
| ubuntu:24.04 arm64, as root | 18.6 (conda), as `basepad` | linux-arm64 | both databases queried |
| GitHub Actions macos-latest, as a user | 18.6 (conda) | darwin-arm64 | both databases queried |
| GitHub Actions ubuntu:24.04 container on x64, as root | 18.6 (conda), as `basepad` | linux-x64 | both databases queried |
| GitHub Actions ubuntu:24.04 container on arm64, as root | 18.6 (conda), as `basepad` | linux-arm64 | both databases queried |

The binaries were built in GitHub Actions on macos-latest, ubuntu-24.04 and ubuntu-24.04-arm. For the CI rows, a job ran this `stack.sh` after each build. They were built at Neon commit `fa504217c61bbcaf5c512d75830564541f917f8f`, and their checksums were verified.

The x64 binary segfaults under qemu emulation on an arm64 Mac. That is an emulation artefact, since it runs fine on a real x64 runner.

## Postgres

- `mise install postgres@18` resolves to 18.6 from conda-forge and installs in seconds.
- **As root:** Postgres refuses to run as root, so basepad does the following:
  - creates a system user: `useradd --system --no-create-home --shell /usr/sbin/nologin basepad`;
  - owns the data directory as that user;
  - runs `initdb` and `pg_ctl` through `runuser -u basepad --`.
- **Gotcha:** mise installs into `/root/.local/share/mise/installs/…`, and `/root` is `0700`. As a result, the system user gets `Permission denied` executing `initdb`. The fix is traverse-only access (`chmod o+x`) on each ancestor of the Postgres `bin` directory. This grants no listing and no read. The alternative is a shared `MISE_DATA_DIR` outside `/root`.
- `initdb -U postgres --auth=scram-sha-256 --pwfile=…` gives a SCRAM `postgres` role, which the proxy needs.
- **Pin the locale:** `initdb --encoding=UTF8 --locale-provider=builtin --locale=C.UTF-8`. Otherwise `initdb` inherits the shell's locale. macOS terminals often set a bare `LC_CTYPE=UTF-8`, which gives `could not find suitable text search configuration for locale "UTF-8"`, and the cluster differs between machines. `builtin` (Postgres 17+) avoids depending on the OS's libc or ICU.
- Listen on `127.0.0.1` only, with the socket directory under basepad's state, not `/tmp`.

## Neon's proxy

### Build

- Build command: `cargo build --locked --release -p proxy --bin proxy --features testing`.
- **`--features testing` is required.** Without it, `--auth-backend=postgres` doesn't exist, and the only backends are `control-plane` and `console-redirect`.
- The toolchain comes from Neon's `rust-toolchain.toml` (1.88.0 at this commit).
- System deps:
  - Linux: `protobuf-compiler libssl-dev pkg-config cmake clang`.
  - macOS: `protobuf cmake`.
  - Not all are proven necessary; this set worked first time.
- Times on GitHub-hosted runners: 13–20 min cold (Linux x64 slowest), about 4 min warm with `Swatinem/rust-cache`.
- **Size:** darwin-arm64 is 47 MB. Linux is 210–220 MB because it is unstripped and carries debug info. Strip it for releases.

### Run

```sh
LOGFMT=text proxy --auth-backend=postgres \
  --auth-endpoint=postgres://postgres:<pw>@127.0.0.1:5432/postgres \
  --wss 127.0.0.1:4444
```

- **No TLS.** With neither `--tls-key` nor `--tls-cert`, the serverless listener accepts plain TCP (`MaybeTlsAcceptor`, `proxy/src/serverless/mod.rs`). So there is no Caddy and no certificate, and nothing expires yearly.
- **Many databases:** the auth endpoint is used only to look up role secrets (`pg_authid`) and allow-lists. The database comes from the client's connection string, so one proxy serves every database on the server. Both were queried through one proxy.
- **Allow-list table:** the mock control plane runs `select allowed_ips from neon_control_plane.endpoints where endpoint_id = $1` in the auth database. Create it empty:
  ```sql
  create schema neon_control_plane;
  create table neon_control_plane.endpoints(endpoint_id text primary key, allowed_ips text);
  ```
  No row means no allow-list.
- The proxy also listens on 4432 (TCP Postgres protocol, `--proxy`), 7000 (`--mgmt`) and 7001 (metrics, `--http`). These are defaults, so set them explicitly when running several proxies.

## Driver settings

```ts
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;           // as in the spike; Node 22+ has a global WebSocket, untested without this
neonConfig.useSecureWebSocket = false;          // plain ws://, the proxy has no TLS
neonConfig.wsProxy = () => 'localhost:4444/v2'; // host:port of --wss, path /v2

new Pool({
  connectionString: 'postgres://postgres:<pw>@localhost:5432/<db>?options=endpoint%3Dlocal',
});
```

- **`?options=endpoint%3D<id>` is required.** Without TLS there is no SNI, so the proxy can't derive an endpoint ID and fails with `Endpoint ID is not specified … pass the endpoint ID … as a parameter: '?options=endpoint%3D<endpoint-id>'`. Any ID works (`local`). basepad should put it in the `DATABASE_URL` it writes.
- The host in the connection string must be `localhost`. The proxy rejects IP hosts. No DNS is needed.
- `pipelineConnect`: the default (`"password"`) works, and so does `false`. The proxy accepts cleartext from the client and does SCRAM itself.
- Tested with `@neondatabase/serverless` 1.2.0 and `ws` 8.

## Open

- Releases: strip the binaries, publish checksums, and lay the archives out for mise's `github:` backend.
- Proxy ports: set `--proxy`, `--mgmt` and `--http` explicitly per proxy, so two can coexist.
