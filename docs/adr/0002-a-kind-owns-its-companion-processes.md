---
status: accepted
---

# A Kind owns its companion processes; services don't link to each other

A process that exists only to serve one service's server, such as Neon's local proxy in front of Postgres, is a daemon of that service's Kind (`postgresWithNeonProxy()`), not a service of its own. It needs setup inside the server (a role password, a schema), the server's actual port, and each environment's database name, which only that Kind knows, and as part of the Kind it cannot point at the wrong service, run twice for one server, or outlive its server. A tool that only uses a service from outside (PostgREST, pgweb) is an App: it reads the service's outputs from env files and depends on its daemon.

## Considered Options

- **A separate `neonProxy({ postgres: "db" })` service linked to the Postgres one.** Turned down: services would start referring to each other, so the proxy would either reach into the Postgres Kind's internals or need a new way to read another service's place and outputs, and it would allow a proxy pointing at a Redis, two proxies for one server, or a proxy left with no server.
- **A `neon: true` option on `postgres()`.** Turned down: `env`'s outputs are typed per Kind, so the proxy's outputs (`wsProxy`) would appear on every Postgres, absent at run time.
- **One daemon whose command starts both programs.** Turned down: `status` could not show the proxy on its own, a proxy crash would go unseen, and the logs would mix.

## Consequences

- A Kind may declare extra daemons; Layout derives their names and ports, as it does a Kind's web domain.
