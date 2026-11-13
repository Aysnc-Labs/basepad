---
status: accepted
---

# The config file is the only way a project talks to basepad

A project describes everything it wants from basepad in one committed TypeScript file, `basepad.config.ts`. Every behaviour basepad has is a default that this file can override (where worktrees live, what they copy, which domains apps answer at), and basepad keeps no memory of its own: names come from the config, and every other fact is asked from its owner (git, Postgres, the process supervisor). We chose this so that a teammate, a fresh worktree and a cloud sandbox all get the same environment from the same file, and so that odd local setups are met by code in the config, not by new basepad options.

## Considered Options

- **A TOML file with presets and rename rules.** Turned down: every new need became a new knob or naming rule, and it could not express conditionals or per-developer differences.
- **TOML for the common case plus TypeScript for flexibility.** Turned down: two forms to document, test and keep equal.
- **Commands that build up state (`basepad add postgres`), kept in a records file.** Turned down: the state lived on one machine, drifted from what the project committed, and had to be migrated and repaired.

## Consequences

- basepad is a devDependency of the project, so the config's import resolves and its version is pinned per project.
- Standing behaviour, which every run should repeat, is a config key with a default, never a command-line flag that has to be remembered. A flag carries only what belongs to one run: an input (`--branch`, `--start`), a consent (`--force`, `--yes`, `--claim`), an output format (`--json`) or the mode of an integration that calls basepad (`--claude`).
- Removing an environment cannot depend on reading its config, which may be broken or gone: it works from names alone.
