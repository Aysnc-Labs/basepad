---
status: accepted
---

# A service runs the program the project's mise config gives it

A service's programs (`postgres`, `redis-server`, `mailpit`, `neon-proxy`) come from the project's mise config, found the way the developer's shell finds them: `up` runs `mise install` and then `mise which <program>` in the checkout that decides the service. basepad doesn't care which tool provides a program, and pins only what runs basepad itself (the mise minimum, Node and pitchfork). We chose this so that every tool and version a project runs lives in one file beside its PHP and Node, the `psql` in a terminal is the same build as the server basepad runs, a project can swap any build (such as a Postgres with PostGIS) without a basepad release, and `mise up` and Renovate bump services as they bump everything else.

This is no exception to [0001](0001-config-is-the-only-interface.md): the config still owns what basepad does; the project's mise config owns which binaries do it.

## Considered Options

- **basepad pins each service's tool and version (the old way).** Turned down: a project could not change a build or version, the terminal's `psql` could differ from the server, and every bump needed a basepad release.
- **A `tool` option in `basepad.config.ts`, such as `postgres({ tool: "github:..." })`.** Turned down: a second place for tools beside `mise.toml`, which the shell, `mise outdated` and Renovate can't see.
- **Fixed tool names that basepad reads from `mise.toml`, such as `[tools] postgres`.** Turned down: it ties the lookup to one name, so a global config, a parent folder's config or an alias under another name would not count, and the shell would find a program basepad doesn't.
- **basepad's defaults layered under the project's mise config.** Turned down: which build runs would depend on two configs at once, and a project that never names a tool would still run one it can't see. A missing program instead fails `up` with the lines to add.

## Consequences

- A command that runs the project's tools or hooks (`up`, `worktree add`, `worktree rm`, `prune`, every `db` command) fails in a project whose mise config isn't trusted, passing on mise's error; `down` passes it on, skips its Down hooks and still stops everything. basepad never trusts a config for the user.
- A worktree whose config resolves a shared service's program to another path than main's fails, since it would run mismatched programs against main's server.
- Postgres's major version comes from the binary, not the config.
