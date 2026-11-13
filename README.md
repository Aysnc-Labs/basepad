<p align="center">
  <img src="docs/rocket.svg" width="220" alt="basepad's rocket on its launch pad">
</p>

<h1 align="center">basepad</h1>

<p align="center">
  A local environment for coding agents.<br>
  On your machine, or in a cloud sandbox.
</p>

---

Tell basepad what your project runs:

```ts
// basepad.config.ts
import { defineConfig, mailpit, postgres, redis } from "basepad";

export default defineConfig({
	name: "shop",
	services: { db: postgres(), cache: redis(), mail: mailpit() },
	apps: {
		web: { run: "next dev" },
		api: { run: "php artisan serve --port=$PORT" },
	},
	env: ({ db, cache, mail, web }) => ({
		".env.local": {
			DATABASE_URL: db.url,
			REDIS_URL: cache.url,
			MAIL_URL: mail.url,
			APP_URL: web.url,
		},
	}),
});
```

`basepad up` starts it. Every agent working in a worktree gets its own copy, with its own data and its own URLs:

```
https://web.shop.localhost              you, on main
https://web.worktree-1.shop.localhost   the agent fixing checkout
https://web.worktree-2.shop.localhost   the agent rewriting search
```

Mail it sends lands in a local inbox at `https://mail.shop.localhost`, and `basepad db save` snapshots its database before it tries something risky.

## Try it

```sh
curl https://mise.run | sh                 # basepad installs everything else through mise
npm install --save-dev basepad
npx basepad init                           # writes a starter config
npx basepad up
```

Run `npx basepad setup` once per machine and your browser will trust the local HTTPS domains. It's worth it for the rocket alone.

Works on macOS (Apple Silicon) and Linux (x64 and ARM).

## Commands

| | |
| --- | --- |
| `basepad up` | Start everything and open mission control (`-d` skips it) |
| `basepad down` | Stop everything. Data and env files stay put |
| `basepad status` | Every app's URL and state |
| `basepad worktree add` | A new branch with its own environment |
| `basepad worktree rm <name>` | Throw one away. The branch survives |
| `basepad db save`, `db load` | Snapshot this environment's database, and put it back |
| `basepad setup` | Once per machine, for trusted URLs with no port |

The [guide](docs/guide.md) has the rest: every config option, how worktrees copy data, the Claude Code hooks, CI and sandboxes, and every key in mission control.

## Hacking on basepad

```sh
mise install && npm ci
npm run check
```

The tests run the real thing against real mise, pitchfork and Postgres. [`AGENTS.md`](AGENTS.md) explains how to keep a test run away from your own setup.

MIT licensed.
