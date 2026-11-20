---
"basepad": minor
---

Add `hooks` to the config: shell commands run around events that change an environment. `basepad up` runs `beforeUp` once services are ready and env files written, and `afterUp` once the apps have started; `basepad down` runs `beforeDown` and `afterDown` around stopping. Hooks run through mise in the environment's checkout, with stdin closed, the env files' keys, `BASEPAD_EVENT` and `BASEPAD_ENVIRONMENT`; an `env` that throws when basepad reads its keys gets a warning that hooks get none. A failed `beforeUp` cancels `up`, a failed `afterUp` makes it exit 1 with the apps running, and failed Down hooks only warn. A hook runs only in a checkout whose `mise.toml` mise trusts: an untrusted one fails `up` with mise's error, and `down` skips its Down hooks with that error and still stops everything. Mission control shows hook output as a `hooks` log row.
