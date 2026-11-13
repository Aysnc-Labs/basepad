# Feature map

Per feature: what it does for its users, and where it starts.

## The config contract

A project describes everything it wants in one committed `basepad.config.ts`: its `name`, services, apps and env files. `defineConfig` types it, so the editor completes keys and `env` sees only the outputs the config declares; `postgres()` makes a Postgres service (17 or 18, default 18).

Starts at: `src/index.ts` (the package's export).

## Loading the config

Finds `basepad.config.ts` in the current folder or the nearest one above, loads it as TypeScript ESM whatever `package.json` says about module type, applies `basepad.config.local.ts` over it when present, and validates. Every failure names the file, and the key at fault.

Starts at: `loadProject` in `src/config.ts`.

## Layout

Derives every name from the project's description and the machine: each app's domain `<app>.<name>.localhost` and URL (port-free when the machine's `portFree` says port 443 reaches the proxy, else with the proxy's port: the one place the URL form is decided), each app's starting port (a block of 20 chosen by the name's hash, in [20000, 32000)), each service's database `<name>_<service>`, its first-tried port (from the name and key, in [15000, 20000)) and its data folder `<home>/services/<name>/<key>`, and the environment's definitions file in the home. Rejects a name past its limit (63-character domain label, 63-byte database name) with the reason, never truncating. The machine is `BASEPAD_HOME` (default `~/.basepad`), `BASEPAD_PROXY_PORT` (default 7443; 443 as root on Linux, where the proxy binds it itself) and `portFree`, which commands ask from port 443 once the supervisor runs, never stored.

Starts at: `layout` and `machine` in `src/layout.ts`.

## Env files

Sets exactly the keys `env` names in the files it names, paths from the config's folder: in place where a key is assigned, appended where not, creating a missing file. Every other byte stays; a value that already reads as wanted is left as written, so a second `up` writes nothing. Values needing quotes get single quotes, else double quotes. A key removed from the config stays in the file.

Starts at: `setKeys` (pure) and `writeEnvFiles` in `src/env-files.ts`.

## Tools

Installs a tool through mise (always asking mise, which waits for an install another basepad has in progress, and is a no-op once installed) and locates its install folder and programs. Runs mise from the home, so no project's mise config is read.

Starts at: `install` in `src/tools.ts`.

## The Catalogue

What basepad provides to an environment: one module per service kind behind one interface (`prepare` returns the daemon to run, `provision` waits for it, provisions the environment and returns the outputs `env` sees, `address` says where it answers). A new kind is a new module and one entry in `CATALOGUE`; commands don't change.

Starts at: `kindOf` in `src/catalogue.ts`.

## Postgres

`postgres({ version })` (17 or 18) gives the project its own server: mise's Postgres, initialised once with trust auth in the service's home folder, on loopback only, no unix socket, on the Layout's port or the next free one (a running server keeps its port, read from its `postmaster.pid`). The database `<name>_<service>` is created and stamped with its owner checkout's path as its comment; another path is refused unless `up --claim`, an unstamped one is stamped. pgvector (`PGVECTOR_VERSIONS`) is installed as `conda:pgvector` and its files copied into the Postgres install, with a marker so a reinstall gets them again. As root on Linux the server runs as the system user `basepad` (`src/internal/service-user.ts`). Outputs: `url` (`postgresql://postgres:basepad@127.0.0.1:<port>/<db>`; the password is a placeholder), `host`, `port`, `user`, `password`, `database`. Data with another Postgres major is refused, never converted.

Starts at: `postgres` in `src/catalogue/postgres.ts`.

## Supervisor

basepad's own pitchfork, isolated in `<home>/pitchfork/{state,config,logs}` so a developer's pitchfork is untouched. Sets its settings through pitchfork (zero ready delay, worktree labels off, HTTPS proxy on the machine's port with DNS, hosts sync, auto-trust and proxy auto-start off) and restarts the supervisor when one changes. Registers an environment's generated definitions against its folder under the name's namespace, taking a namespace over from another folder (stopping its daemons) and saying which folder holds it (`owner`); starts what is not running and waits a bounded time for each daemon to listen or fail; stops, reports state and reads logs. The CA is `<home>/pitchfork/state/proxy/ca.pem`. `standardPort` asks what answers on port 443: basepad's proxy only when its certificate verifies against that CA (so Herd, Valet or a developer's own pitchfork there count as `other`). Wraps `pitchfork proxy setup` (`--dry-run` plan, `--yes` on the user's terminal) and `pitchfork proxy trust`. Processes it starts get the CA as `NODE_EXTRA_CA_CERTS` and `PITCHFORK_CA_FILE`; other runtimes need their own setting (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`).

Starts at: `openSupervisor` in `src/supervisor.ts`.

## `basepad up`

Refuses when the name is registered from another checkout, naming it, unless `--claim`. Prepares each service through the Catalogue and registers services and apps with the supervisor (each app runs from its folder with its own and the project's `node_modules/.bin` on PATH, and gets a free `PORT`). As root on Linux trusts the CA (system store and browsers' NSS stores, no prompt); asks port 443 for the URL form; adds the project's domains to `/etc/hosts` where they do not resolve for server-side code (or prints the lines when it cannot write). Starts the services and provisions them, writes the env files with the services' outputs and each app's URL, starts the apps that are not running, waits up to 5 s (and up to 3 s more for the proxy, which re-reads routes every 2 s, to route each new domain), prints the APP/URL/STATE and SERVICE/ADDRESS/STATE tables and returns. An app or service that exits on start is shown with its last output and the command for its full log, and `up` exits 1. `-d` is accepted.

Starts at: `up` in `src/commands.ts`.

## `basepad down`

Stops the project's running apps and services. Deletes nothing; a service's data stays in the home.

Starts at: `down` in `src/commands.ts`.

## The `basepad` command

Checks that mise is at least `MISE_MIN_VERSION`, then runs basepad on the current Node when it is 24 or newer, else again on mise's Node 24. Dispatches commands, and generates `--help`, from one table; a mistyped command or flag names the nearest one.

Starts at: `src/launcher.ts` (the bin), then `src/cli.ts`; commands are declared in `COMMANDS` in `src/commands.ts`. Tool versions live in `src/versions.ts`.

## `basepad init`

Writes a starter `basepad.config.ts` named from the folder, adds `basepad.config.local.ts` to `.gitignore`, and adds basepad as a devDependency when `package.json` lacks it. Refuses to overwrite an existing config.

Starts at: `init` in `src/commands.ts`.

## `basepad status`

Prints one row per app with its URL and live state (`running`, `starting`, `failed` or `stopped`), then one per service with its address (where it runs, else where it would first be tried) and state. Starts no supervisor when none runs; then the URL form is the port's default, since nothing answers on 443 to ask.

Starts at: `status` in `src/commands.ts`.

## `basepad setup`

Once per machine: trusts basepad's CA and makes URLs port-free. Prints the plan first (pitchfork's own proxy-setup plan against basepad's isolated pitchfork: login-keychain trust and a pf redirect of 443 on macOS, system trust and an iptables redirect on Linux; plus certutil into Chrome's and Firefox's NSS stores on Linux), then asks; `--dry-run` prints only, `--yes` skips the question, no terminal and no `--yes` refuses. Warns when something else answers on 443; refuses when a developer's own pitchfork setup holds the pf anchor or Linux CA file it would overwrite. As root on Linux it applies with no prompt, and `up` does the same itself. Without it everything works with the port in each URL.

Starts at: `setup` in `src/setup.ts`.

## Hosts file

Where `*.localhost` does not resolve for server-side code (glibc without systemd's resolver, as in a container), `up` writes the project's domains as a marked block `# >>> basepad <name>` in `/etc/hosts`, in place (a bind mount in Docker), or prints the lines when it cannot write.

Starts at: `syncHosts` in `src/hosts.ts`.
