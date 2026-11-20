---
"basepad": minor
---

A worktree whose `mise.toml` resolves a different program than main's for a service on main's servers (Postgres, its Neon proxy, Mailpit, a shared Redis) now fails `up` and `worktree add` there, naming both paths, instead of running mismatched tools against main's server. `down` and `status` in it still work.
