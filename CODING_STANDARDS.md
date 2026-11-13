# Coding standards

Judgment calls `code-review` applies to every diff. A rule a tool can check moves to the table below.

## Review rules

1. **Config is the only interface.** New behaviour is a config key with a default, never a flag; basepad stores no decisions. ([ADR 0001](docs/adr/0001-config-is-the-only-interface.md))
2. **Layout derives every name.** Domains, URLs, database names, ports and home paths are computed only in `src/layout.ts`.
3. **A service kind is one module.** Adding one touches one Catalogue module and `CATALOGUE`, nothing else. (`src/catalogue.ts`)
4. **Never truncate a name.** Reject it with the reason.

## Enforced by tools

| Rule | Enforcer | Where |
|---|---|---|
| Formatting and lint | biome | `biome.json` |
| Types | `tsc --noEmit` | `tsconfig.json` |
| Feature map matches the code | `check-feature-map` | `scripts/check-feature-map.ts` |
