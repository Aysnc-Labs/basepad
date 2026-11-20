---
"basepad": minor
---

Redis and Mailpit now come from your project's `mise.toml`, as Postgres does: basepad no longer installs `redis@8` or `mailpit@1` itself. A worktree's own Redis runs the `redis-server` of the worktree's `mise.toml`; main's Redis, `redis({ worktree: "shared" })` and Mailpit run main's. A project without them gets the lines to add: prebuilt `redis = "8.10.3-1"` and `mailpit = "1.33.1"`.
