# Verification

## Access

How an agent gets into the app with nobody there.

- None: basepad is a CLI with no login. An agent runs the built `dist/launcher.js` through `sandbox()` in `test/sandbox.ts`.
- No credentials. Outside a container, `basepad setup` runs only with `--dry-run`: it changes the trust store and asks for `sudo`.

## Checklist

Areas a careful human tester keeps in mind when testing a change on this project. The `aysnc-skills:prove-it` skill's verifier weighs each one against the changed surface and tests the ones that apply. Add your project's own risks.

- **Does it work:** every behaviour the PR changed, including failure paths, edge cases and wrong input or config, on macOS as a user and on Linux as root.
- **Does it say why:** an error names the cause and the fix, and output matches what `status` reports.
- **Does it stay put:** nothing leaks into the developer's `~/.basepad`, mise or pitchfork state; a sandbox cleans up after itself.
- **Does it repeat:** `up`, `down`, `worktree add` and `rm` run twice in a row leave the same state.
- **Is it safe:** `setup` touches the trust store, hosts file and `sudo` only when asked; no secrets in output or env files.
