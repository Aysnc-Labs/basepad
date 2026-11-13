# basepad

## Commands

- `npm run check`: the one gate CI runs (biome, tsc, feature-map check, tests). Green locally means green in CI.
- `npm test`: the tests; builds `dist` first. One file: `npx vitest run test/<file>.test.ts`.

## Conventions

- CLI tests go through `sandbox()` in `test/sandbox.ts` and dispose it; never touch the developer's `~/.basepad`, mise or pitchfork state.
- Export `MISE_DATA_DIR` and `MISE_CACHE_DIR` to a temp dir before `npm test` to keep tool installs out of your own mise.
- Give each test file's project its own `name`: a service's port comes from it.
- Outside a container, run `basepad setup` only with `--dry-run`: it changes the trust store and asks for `sudo`.

## Agent skills

- Each feature's purpose, entry point and code: `docs/feature-map.md`. Start every task there.
- Issue tracker: GitHub `Aysnc-Labs/basepad`, via `gh`; see `docs/agents/issue-tracker.md`. Labels: `docs/agents/triage-labels.md`.
- Domain: `GLOSSARY.md` and `docs/adr/`, read as `docs/agents/domain.md` says.
- Review rules: `CODING_STANDARDS.md`.
- Code changes: load `aysnc-skills:tdd` and `aysnc-skills:codebase-design`. Glossary or ADR: `aysnc-skills:domain-modeling`. Docs agents read: `aysnc-skills:writing-for-agents`.
