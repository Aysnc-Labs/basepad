---
"basepad": minor
---

Run Create and Remove hooks. `beforeCreate` and `afterCreate` run in a new worktree, from `worktree add` or the first `basepad up` in a git worktree made by hand: `beforeCreate` before its databases and env files are made, `afterCreate` once they are, before `--start`'s apps. A failure exits 1 and keeps the worktree. `beforeRemove` and `afterRemove` come from main's config and run from main's folder around `worktree rm` and for each worktree `prune` clears, with `BASEPAD_WORKTREE`; their failures only warn. Breaking: `worktrees.setup` is gone and rejected as an unknown key; move its commands to `hooks.afterCreate`.
