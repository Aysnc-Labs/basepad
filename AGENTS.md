# basepad

Before changing code, read `GLOSSARY.md`, `docs/adr/` and `docs/feature-map.md` (what each feature does and where it starts); keep the feature map current when a feature changes.

## Commands

All tests are the `test` kind; there is no `e2e` or `check` kind yet.

- `npm test`: every test. Builds `dist` first (`test/build.ts`), since CLI tests run the built bin. One file: `npx vitest run test/<file>.test.ts`.
- `npm run check`: the gate CI runs: `biome check`, `tsc --noEmit` (which also checks the `@ts-expect-error` lines in `test/define-config.test.ts`), then `npm test`.
- `npx biome check --write .`: format and fix lint.

Two seams, both `test`: pure modules called in process (Config, Layout), and the built CLI in a sandbox (`test/sandbox.ts`). In-process config loading goes through Vite's TypeScript transform, not basepad's load hook, so anything about how a config file is loaded is tested through the CLI.

## Isolating a lane

A lane is a git worktree of its own on its own branch. Its tests must never touch the user's basepad, mise or pitchfork state:

- `test/sandbox.ts` gives every test file its own `BASEPAD_HOME`, `MISE_STATE_DIR`, `MISE_CONFIG_DIR` and `PITCHFORK_{STATE,CONFIG,LOGS}_DIR` under a fresh temp dir. Make new CLI tests through `sandbox()` and `box.project()`.
- Tool installs go to `MISE_DATA_DIR`, which the sandbox leaves alone. Export `MISE_DATA_DIR` and `MISE_CACHE_DIR` to a lane temp dir before `npm test` to keep installs (Node 18 and 24 for the launcher test) out of the user's mise.
- Ports: a sandbox picks free ports itself; hard-coded ports collide between lanes.
- Running basepad by hand: `node dist/launcher.js <command>` with `BASEPAD_HOME` set to a temp dir.

## Skills to load

- Any code change: `aysnc-skills:tdd` and `aysnc-skills:codebase-design`.
- Glossary or ADR edits: `aysnc-skills:domain-modeling`.
- This file, or any doc an agent reads: `aysnc-skills:writing-for-agents`.
