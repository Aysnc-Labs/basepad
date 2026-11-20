---
"basepad": minor
---

Postgres and Neon's proxy now come from your project's `mise.toml`: `basepad up` runs `mise install` and `mise which` in main's checkout and runs those programs, so the `psql` in your terminal is the server's build. A project without them gets the lines to add (prebuilt Postgres `18.7-3` with pgvector and PostGIS, and `neon-proxy` `8853-1`); an untrusted `mise.toml` gets mise's error and the `mise trust` command. `postgres({ version })` and `postgresWithNeonProxy({ version })` are removed and rejected as an unknown key: the Postgres build in `mise.toml` decides the version, read from `postgres --version`. The `PostgresVersion` type is removed. basepad no longer copies pgvector in from conda; extensions come with the build.
