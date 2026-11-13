# basepad

Local environments for a project, native through [mise](https://mise.jdx.dev), with no Docker. A project commits one file, `basepad.config.ts`, that names the project, the services it needs, the apps it runs and the values its env files get. `basepad up` then runs a Postgres server of the project's own, runs each app at `https://<app>.<name>.localhost`, and sets exactly the env keys the config names. The same file gives the same environment on a laptop, in CI and in a cloud sandbox. macOS on Apple Silicon, and Linux (x64 and ARM, glibc).

Work in progress: basepad isn't on npm yet.

## Install

mise is the one thing you install by hand. basepad installs everything else it needs through it: Postgres, [pitchfork](https://pitchfork.jdx.dev) (which runs the apps and serves their domains) and, when your project's Node is older than 24, a Node 24 to run on.

1. Install mise 2026.10.24 or later, and activate it in your shell, as [mise's guide](https://mise.jdx.dev/getting-started.html) says:

   ```sh
   curl https://mise.run | sh
   ```

2. Add basepad to your project as a devDependency, so its version is pinned in your lockfile and `npm ci` brings it to teammates, CI and sandboxes. Until it is on npm, install it from GitHub:

   ```sh
   echo "allow-git=root" >> .npmrc   # npm 12 installs git dependencies only when allowed
   npm install --save-dev github:Aysnc-Labs/basepad
   ```

   npm warns that basepad's `prepare` script, its build, isn't covered by `allowScripts`. It runs anyway.

## A first project

In a new folder, with only mise installed:

```sh
mkdir shop && cd shop
mise use node@24
npm init -y
echo "allow-git=root" >> .npmrc
npm install --save-dev github:Aysnc-Labs/basepad
npx basepad init
```

`init` writes a starter `basepad.config.ts`, named after the folder, and adds `basepad.config.local.ts` to `.gitignore`. Give the project a database and an app:

```ts
import { defineConfig, postgres } from "@aysnc-labs/basepad";

export default defineConfig({
	name: "shop",
	services: {
		db: postgres(),
	},
	apps: {
		web: { run: "node server.mjs" },
	},
	env: ({ db, web }) => ({
		".env.local": { DATABASE_URL: db.url, APP_URL: web.url },
	}),
});
```

An app is any command that listens on `PORT`. Here, `server.mjs`:

```js
import { createServer } from "node:http";

createServer((req, res) => res.end("Hello from shop\n")).listen(process.env.PORT);
```

Then:

```sh
npx basepad up
```

```
APP  URL                              STATE
web  https://web.shop.localhost:7443  running

SERVICE  ADDRESS                                        STATE
db       postgresql://postgres@127.0.0.1:17227/shop_db  running
```

`up` returns once everything has started. `.env.local` now holds:

```sh
DATABASE_URL=postgresql://postgres:basepad@127.0.0.1:17227/shop_db
APP_URL=https://web.shop.localhost:7443
```

The URL carries the proxy's port, and its certificate is signed by basepad's own certificate authority, which nothing trusts yet. Point curl at it:

```sh
curl --cacert ~/.basepad/pitchfork/state/proxy/ca.pem https://web.shop.localhost:7443
```

To open it in a browser with no port and no warning, run [`basepad setup`](#port-free-urls-basepad-setup) once on the machine.

```sh
npx basepad status   # each app and service, with its address and state
npx basepad down     # stop them; the database's data stays
```

## The config

`basepad.config.ts`, at the project's root, is the only way a project talks to basepad. It is TypeScript, and it loads whatever `package.json` says about module type. basepad looks for it in the folder you run in, then each folder above, so one config at a repo's root covers every app in it, and commands work from any subfolder.

```ts
import { defineConfig, postgres } from "@aysnc-labs/basepad";

export default defineConfig({
	name: "shop",
	services: {
		db: postgres({ version: 18 }),
	},
	apps: {
		web: { run: "next dev" }, // https://web.shop.localhost
		cms: { run: "npm run dev", cwd: "apps/cms" }, // https://cms.shop.localhost
		backend: { run: "php artisan serve --port=$PORT", cwd: "backend" },
	},
	env: ({ db, cms, backend }) => ({
		".env.local": { DATABASE_URL: db.url, CMS_URL: cms.url },
		"backend/.env": {
			DB_HOST: db.host,
			DB_PORT: db.port,
			DB_DATABASE: db.database,
			APP_URL: backend.url,
		},
	}),
});
```

| Key        | Required | What it is                                                                                                                                |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | yes      | The project's one key: a lowercase DNS label (letters, digits, hyphens). Every database and domain is built from it.                      |
| `services` | no       | The services basepad provides, by key. The one kind is Postgres: `postgres()`, or `postgres({ version: 17 })`. 18 is the default. |
| `apps`     | no       | The project's own processes, by key. Each has `run`, a shell command, and optionally `cwd`, a folder relative to the config.              |
| `env`      | no       | A function from every service's and app's outputs to the env files to write: each file's path, relative to the config, to its keys.       |
| `worktrees` | no      | How [worktrees](#worktrees) are made: `prefix` (default `worktree`) names them `<prefix>-<n>`; `dir`, relative to the config, is where they are checked out (default `<repository>/../<name>.worktrees`); `clone` lists untracked paths copied from main, such as `node_modules`; `setup` lists shell commands run once in each new worktree. |

Keys of `services` and `apps` are lowercase DNS labels, and one key can't be both. A name that would make a domain label or a database name longer than 63 characters is rejected with the reason, counting a worktree's names (up to `<prefix>-999`); basepad never shortens one.

`defineConfig` types the file, so your editor completes keys, and `env` sees only the outputs the config declares. An invalid config fails with the file and the key at fault.

### What `env` gets

A service gives:

| Output     | Postgres                                                    |
| ---------- | ----------------------------------------------------------- |
| `url`      | `postgresql://postgres:basepad@127.0.0.1:<port>/<database>` |
| `host`     | `127.0.0.1`                                                 |
| `port`     | the server's port, a number                                 |
| `user`     | `postgres`                                                  |
| `password` | `basepad`, a placeholder: local connections need none       |
| `database` | `<name>_<key>`, with hyphens made underscores: `shop_db`    |

An app gives `url`: `https://<key>.<name>.localhost`, with the proxy's port (`:7443`) until `basepad setup` has been run. An app's port isn't given: it changes from run to run.

### Env files

basepad sets exactly the keys `env` returns, in the files it names:

- A key already in the file is changed in place; a missing one is appended. A missing file is created.
- Every other line stays byte for byte: your secrets, comments and order.
- A value that needs quotes is quoted.
- Running `up` again changes nothing, unless a value changed (a port moved, say).
- A key you remove from `env` stays in the file. basepad keeps no memory of having written it, so delete it yourself.

### Apps

- Each app runs from its `cwd` (the config's folder by default), through `sh`, with its own and the project's `node_modules/.bin` first on `PATH`, as `npm run` does. So `next dev` works without `npx`.
- Each app is given a free port as `PORT`, and must listen on it.
- Each app answers at `https://<key>.<name>.localhost`, through pitchfork's proxy. Hot reload and WebSockets work through it.
- Processes basepad starts trust its certificate authority through `NODE_EXTRA_CA_CERTS`, so one Node app can fetch another by its URL. Other runtimes need their own setting, such as `SSL_CERT_FILE` or `REQUESTS_CA_BUNDLE`, pointed at `~/.basepad/pitchfork/state/proxy/ca.pem`.

### Postgres

- Each Postgres service is a server of the project's own, from mise, listening on `127.0.0.1` only, with trust authentication. No other project shares it.
- Its port comes from the project's name, so it is the same on every machine. When something else holds it, `up` takes the next free one and rewrites your env files.
- `up` creates the database `<name>_<key>`, and keeps its data across `down` and `up` in `~/.basepad/services/<name>/<key>`.
- Postgres's standard extensions and pgvector are there for `CREATE EXTENSION`. basepad enables none; see [Extensions](#extensions).
- Data from another Postgres major version is refused, never converted. To change `version`, dump the database first.

### Snapshots: `basepad db`

```sh
npx basepad db save before-migration   # snapshot this environment's database
npx basepad db load before-migration   # put it back; the snapshot stays
npx basepad db snapshots               # label, service, database and size of each
npx basepad db rm before-migration     # delete one
```

- They act on the database of the environment you run them in: inside a worktree, the worktree's, never main's. A `shared` service's database is main's, so a worktree refuses it; run the command in main.
- With no label, `save` and `load` use `default`. Saving a label again replaces its snapshot. A label is lowercase letters, digits and inner hyphens; one that makes the database name past Postgres's 63 bytes is refused, with how much room is left.
- With one database the service is implied; with several, name it: `--service db` (`-s db`).
- A snapshot is a database on the same server, `<database>@<label>`, copied as a worktree's is: a file clone where the server offers one, else a template copy. They work while your app runs: its sessions on the database are ended, and it reconnects by itself (see the `Pool` note under Worktrees).
- `load` drops the database and copies the snapshot in its place. If that copy fails the snapshot is kept: run `load` again.
- `worktree rm` and `prune` delete a worktree's snapshots with it.

### Worktrees

A worktree is a second environment of the project, for working on another branch beside main. In main, run:

```sh
npx basepad worktree add          # prints the table and where it is
npx basepad worktree add --json   # {"name":"worktree-1","path":"/…/shop.worktrees/worktree-1"}
npx basepad worktree add --branch fix-login   # on that branch, made from main's HEAD if it doesn't exist
npx basepad worktree add --start  # starts its apps now
```

- It is a git worktree, named `worktree-1`, `worktree-2` and so on: the lowest number no git worktree, branch or folder already has. It is checked out on a new branch of the same name from main's `HEAD`, or on `--branch`'s, beside the repository in `../<name>.worktrees`, so main's watchers never see it.
- Each Postgres service gets a database `<name>_<key>_<suffix>` (`shop_db_worktree_1`) on main's server, holding a copy of main's data. `postgres({ worktree: "empty" })` gives an empty one instead, and `postgres({ worktree: "shared" })` uses main's own database.
- Its apps answer at `https://<app>.<suffix>.<name>.localhost`, beside main's.
- Each env file `env` names starts as a copy of main's, secrets included, then basepad sets its keys for the worktree. A file the worktree already has is kept.
- Each path in `worktrees.clone` is copied from main, copy-on-write where the filesystem can (APFS, btrfs, XFS) and fully otherwise, so the worktree's writes never reach main's files. A path main lacks is skipped with a note. A full copy is slow: about 10 s for a `node_modules` of 34,000 files on Linux's ext4.
- Then the commands in `worktrees.setup` run in order in the worktree, with its env files written. The first that fails is shown with its output, the rest don't run, `worktree add` exits 1 and the worktree is kept.
- `worktree add` starts no app: an app starts when its domain is first opened, with main's services if they are stopped, or straight away with `--start`. After `down`, an app stays stopped until `up`. `basepad up`, `down` and `status` in the worktree's folder act on it, with the config in that folder. A worktree's services are main's servers, so `up` there starts main's services too, and `down` there stops only the worktree's apps.
- The copy works while main's app is connected. basepad closes main's database to connections for the copy, ends its sessions and opens it again; main's app reconnects by itself. A node-postgres `Pool` needs an `error` listener (`pool.on("error", …)`), or an ended idle client crashes its process. If a copy is interrupted, the next `basepad up` opens main's database again.
- The copy is a file clone where the server offers one (Postgres 18 on APFS, btrfs or XFS with reflink: copy-on-write), else a template copy (about 1 s per GB on Linux), else dump and restore. The output says which.

basepad keeps no list of worktrees: it asks git which exist.

To see and remove them, in main:

```sh
npx basepad worktree ls               # each worktree, its branch and folder
npx basepad status                    # main, then each worktree's apps and services
npx basepad worktree rm worktree-1    # stops its apps, drops its databases, removes the git worktree
npx basepad prune                     # clears what worktrees whose folder you deleted left behind
```

- `worktree rm` keeps the branch. It refuses a worktree with uncommitted or untracked files; `--force` removes it anyway, and they are lost. It needs only main's config and git, so a worktree's broken or missing config, a folder already deleted, or names main's config has since made too long do not stop it. It never drops main's database, so a `shared` service's stays.
- `prune` lists what worktrees whose folder is gone left (git's record, databases, registrations), then asks before removing it; `--yes` removes it without asking. It also lists the data of services no longer in the config, main's included, and deletes that only when you answer yes on a terminal, even with `--yes`.

#### A git worktree made by hand

`basepad up` in any linked git worktree of main makes it a worktree, with its folder's name as the suffix: `git worktree add ../hand` then `basepad up` in `../hand` gives `shop_db_hand` with main's data and `https://web.hand.shop.localhost`. The folder name must be a lowercase DNS label (letters, digits and inner hyphens); any other is refused with the reason. `git worktree move` renames it.

#### Claude Code

Claude Code makes worktrees for `claude --worktree`, background sessions and subagents with `isolation: "worktree"`. Its `WorktreeCreate` and `WorktreeRemove` hooks route that through basepad, so every session gets a full environment. In `.claude/settings.json`:

```json
{
  "hooks": {
    "WorktreeCreate": [{ "hooks": [{ "type": "command", "command": "npx basepad worktree add --claude" }] }],
    "WorktreeRemove": [{ "hooks": [{ "type": "command", "command": "npx basepad worktree rm --claude" }] }]
  }
}
```

- `worktree add --claude` reads the hook's input on stdin, makes a worktree as `worktree add --branch <name>` does with the name Claude Code asks for (`bold-oak-a3f2`), and prints only its path on stdout. Everything else goes to stderr. If setup fails, it exits 1 and the session does not start; the worktree is kept.
- `worktree rm --claude` removes the worktree at the input's `worktree_path` as `worktree rm --force` does, since Claude Code asks before discarding work. The branch is kept.
- Claude Code removes the worktree of a session you exit. It keeps a subagent's: remove it with `basepad worktree rm`.

### The local file

`basepad.config.local.ts`, beside the config, adjusts it for your machine only; `basepad init` adds it to `.gitignore`. When it exists, basepad loads it after the config. Its default export is a function that gets the project's config and returns the changed one:

```ts
import type { LocalConfig } from "@aysnc-labs/basepad";

const local: LocalConfig = (config) => ({
	...config,
	apps: { ...config.apps, web: { run: "node --watch server.mjs" } },
});

export default local;
```

## Commands

Run them anywhere in the project, as `npx basepad <command>`. `basepad --help` lists them, and `basepad <command> --help` gives a command's flags. A mistyped command or flag names the nearest one and exits 1.

| Command          | What it changes                                                                                                                                                                        | What it never touches                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `basepad init`   | Writes `basepad.config.ts`, named after the folder. Adds `basepad.config.local.ts` to `.gitignore`, creating it. Adds basepad to `package.json`'s devDependencies when it isn't there. | An existing config: it refuses to overwrite one. It installs nothing.             |
| `basepad up`     | Installs what it needs through mise, starts the services, creates their databases, sets the env files' keys, starts the apps, prints the tables above and, on a terminal, opens mission control.                              | Any other file in the project, any other line of an env file, your own pitchfork. |
| `basepad down`   | Stops the project's apps and services. Its apps stay stopped, whatever opens their domains, until `up`.                                                                               | Data and env files: it deletes nothing.                                           |
| `basepad status` | Nothing. Prints each app with its URL and each service with its address, and their state: `running`, `starting`, `failed` or `stopped`. In main, then each worktree's.               | Anything: it starts nothing.                                                      |
| `basepad worktree add` | Checks out a git worktree beside the project, copies `worktrees.clone` into it, creates its databases from main's, writes its env files from main's and runs `worktrees.setup`. Starts main's services. Ends main's database sessions for the copy. | Main's data and env files, apart from what `up` in main would set. It starts no app, unless `--start`. |
| `basepad worktree ls` | Nothing. Lists main's worktrees with their branch and folder. | Anything. |
| `basepad worktree rm <worktree>` | Stops the worktree's apps, drops its databases, removes its registration and its git worktree. | Its branch, main's data. Uncommitted work: it refuses unless `--force`. |
| `basepad prune` | After asking: removes what worktrees whose folder is gone left, and the data of services no longer in the config. | Anything you did not say yes to. Main's databases of services still in the config. |
| `basepad db save [label]`, `db load [label]` | `save` makes a snapshot of this environment's database, replacing one of the same label; `load` replaces the database with it. Ends the database's sessions. | Other environments' databases and snapshots. `load` keeps the snapshot. |
| `basepad db snapshots`, `db rm <label>` | `snapshots` changes nothing and lists this environment's; `rm` deletes one. | Anything else. |
| `basepad setup`  | The machine, once: trusts basepad's certificate authority and makes URLs port-free. See [below](#port-free-urls-basepad-setup).                                                        | Any project. A pitchfork setup of your own: it refuses rather than overwrite it.  |

More on `up`:

- A second `up` starts only what isn't running, so it is fast and safe to repeat.
- On a terminal, `up` then opens mission control: every environment (main and each worktree) with its branch and state, the selected one's apps and services with state and address, and their logs live. Its keys, also listed at its foot:
  - `↑` `↓` pick an environment; `←` `→` pick one of its apps or services, and narrow the logs to it.
  - `s`, `x` and `r` start, stop and restart the selected app or service; with none selected, the whole environment (main's apps and services, or a worktree's apps, as `up` and `down` do). A stopped app stays stopped: a request does not start it again until `s`.
  - `o` opens the selected app in the browser; `c` copies the selected address (a database's URL, say). With none selected, both take the environment's first app.
  - `a` adds a worktree, as `basepad worktree add` does; it shows in the list once it is made, and its progress shows meanwhile. `d` removes the selected worktree, as `basepad worktree rm` does, after you press `y`. One with uncommitted changes asks again: type its name and press enter to lose them. Either runs in a process of its own: `q` closes the view at once and it goes on, and `up` again shows it still under way.
  - `v` shows the apps' logs side by side, a column each.
  - `PgUp` `PgDn` scroll back, which pauses the logs; `End` goes back to live. `/` searches them (ignoring case), `n` and `N` step to older and newer matches.
  - `esc` steps back: out of a search or a pause, then to all logs. `q` or Ctrl-C closes it and leaves everything running; `up` again reopens it. Run `up` in a worktree's folder and it opens on that worktree.
  - It fits terminals down to 72×16 and follows a resize; smaller, it says how big it needs to be. It uses your terminal's own colours where it has only 16, and none with `NO_COLOR` set.
- `up -d` returns once started, without mission control, as `up` does with no terminal attached (scripts, CI, agents).
- An app or service that exits on start is shown with its last output and the command for its full log, and `up` exits 1. It works the same with no terminal attached, so CI fails loudly.
- An app still starting after 5 seconds is shown as `starting`; `up` doesn't wait for it.
- `up` refuses when another folder on the machine already uses the project's name, and names that folder: two checkouts would share one database. If the project moved, or this checkout should take over, run `basepad up --claim`. The other checkout's apps and services stop, and the database becomes this checkout's.

basepad keeps its own state in `~/.basepad` (or `BASEPAD_HOME`): each service's data, and a pitchfork of its own, separate from any pitchfork of yours. Nothing there records decisions, so to start a project's database over, stop it and delete its folder:

```sh
npx basepad down && rm -rf ~/.basepad/services/shop
```

## Port-free URLs: `basepad setup`

Without setup, everything works, with the port in each URL (`https://web.shop.localhost:7443`) and a certificate your browser doesn't trust. Once per machine:

```sh
npx basepad setup
```

It prints its plan, then asks before it changes anything. Steps marked `[sudo]` ask for your password.

- **macOS:** trusts basepad's certificate authority, and redirects port 443 to the proxy's port with a pf rule.
- **Linux:** trusts the certificate authority in the system store and in Chrome's and Firefox's own stores, and redirects port 443 with iptables.

Then run `basepad up` in each project, so its env files get the port-free URLs. When something else answers on port 443 (Herd, Valet), setup warns you first. A restart can drop the redirect; run `setup` again if URLs get their port back.

`--dry-run` prints the plan and changes nothing. `--yes` applies it without asking, and is needed when there's no terminal to ask on.

```sh
npx basepad setup --dry-run
```

## Notes

### Apps that ignore `PORT`

Some dev servers pick their own port. Give it to them in `run`. Vite:

```ts
apps: {
	web: { run: "vite --port $PORT --strictPort" },
},
```

Vite and Next accept `*.localhost` hosts by default, and their hot reload works through the domain.

### Frameworks behind the proxy

The proxy forwards each request to `localhost:<port>`, with the real domain in `X-Forwarded-Host` and `https` in `X-Forwarded-Proto`. A framework that builds URLs from the request must trust those headers. Laravel, in `bootstrap/app.php`:

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '127.0.0.1');
})
```

and serve it on basepad's port: `run: "php artisan serve --port=$PORT"`.

### Extensions

basepad enables no extension. Enable the ones you use in your own migrations, so every environment and production get them the same way:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Postgres's standard extensions (`pg_trgm`, `citext`, `hstore` and the rest) and [pgvector](https://github.com/pgvector/pgvector) are installed, on 17 and 18.

### Your own database

basepad's Postgres is optional. Leave `services` out and write your own values into `env` as plain strings; you still get apps, domains and env files:

```ts
import { defineConfig } from "@aysnc-labs/basepad";

export default defineConfig({
	name: "notes",
	apps: {
		web: { run: "vite --port $PORT --strictPort" },
	},
	env: ({ web }) => ({
		".env.local": {
			DATABASE_URL: "postgresql://me@localhost:5432/notes",
			APP_URL: web.url,
		},
	}),
});
```

## Cloud sandboxes and CI

`npm ci && npx basepad up` gives a sandbox or a CI job the same environment as your laptop. The setup script installs mise, the project's tools and its packages:

```bash
#!/usr/bin/env bash
set -euo pipefail
curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
mise install # the project's own tools, Node among them, from its mise.toml
npm ci
```

Then, each time the sandbox starts (a sandbox keeps no processes), or in the CI job before the tests:

```sh
npx basepad up
```

On a bare Ubuntu image, install what mise and npm need first: `apt-get install -y curl ca-certificates git xz-utils`.

As root on Linux (most cloud sandboxes and containers), `up` needs no human:

- Postgres refuses to run as root, so basepad runs it as a system user, `basepad`, which it creates. mise installs under `/root`, so basepad gives that user traverse-only access (`o+x`) to the folders above Postgres's programs and data.
- The proxy listens on port 443 itself, and `up` trusts its certificate authority in the system store and the browsers' stores, so URLs are port-free with no `basepad setup` and no prompt.
- Where `*.localhost` doesn't resolve for server-side code (glibc without systemd's resolver, as in most containers), `up` adds the project's domains to `/etc/hosts`, in a block marked `# >>> basepad <name>`. When it can't write the file, it prints the lines to add.

As a user, as on a hosted CI runner, URLs keep their port, and tools basepad doesn't start (a test runner, say) need its certificate authority, `~/.basepad/pitchfork/state/proxy/ca.pem`: for Node, set `NODE_EXTRA_CA_CERTS` to it.

## Development

```sh
mise install && npm ci
npm run check
```

The tests run the built `basepad` command against real mise, pitchfork and Postgres, in temporary folders on free ports. CI runs them on macOS as a user and on Ubuntu 24.04 as root. [`AGENTS.md`](AGENTS.md) says how to keep a test run away from your own basepad.

## License

MIT
