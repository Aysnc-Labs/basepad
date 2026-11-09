#!/usr/bin/env bash
# Brings up Postgres 18 (mise, conda) and Neon's proxy natively, then queries two databases
# through @neondatabase/serverless. As root, Postgres runs as the `basepad` system user.
# Usage: PROXY_BIN=/path/to/proxy ./stack.sh
# In a container: docker run --rm -v "$PWD:/spike" -v /path/to/linux/proxy:/proxy ubuntu:24.04 /spike/stack.sh
set -euo pipefail
PROXY_BIN="${PROXY_BIN:-/proxy}"
PGPORT="${PGPORT:-5432}"
WSS_PORT="${WSS_PORT:-4444}"
WORK="${WORK:-/tmp/basepad-spike}"

if ! command -v mise >/dev/null; then
  if [ "$(uname)" = Linux ] && [ "$(id -u)" = 0 ]; then
    apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
  fi
  curl -fsSL https://mise.run | sh >/dev/null
  export PATH="$HOME/.local/bin:$PATH"
fi
mise install -q postgres@18 node@24
PGBIN="$(mise where postgres@18)/bin"
export PATH="$PGBIN:$(mise where node@24)/bin:$PATH"

run_pg() { "$@"; }
if [ "$(id -u)" = 0 ]; then
  # Postgres refuses root. The system user needs traverse-only access to root's mise installs.
  d="$PGBIN"; while [ "$d" != / ]; do chmod o+x "$d"; d=$(dirname "$d"); done
  id basepad >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin basepad
  run_pg() { runuser -u basepad -- "$@"; }
fi

rm -rf "$WORK" && mkdir -p "$WORK" && echo postgres > "$WORK/pw"
[ "$(id -u)" = 0 ] && chown -R basepad: "$WORK"
run_pg initdb -D "$WORK/data" -U postgres --auth=scram-sha-256 --pwfile="$WORK/pw" \
  --encoding=UTF8 --locale-provider=builtin --locale=C.UTF-8 >/dev/null
run_pg pg_ctl -D "$WORK/data" -o "-p $PGPORT -k $WORK -c listen_addresses=127.0.0.1" -l "$WORK/pg.log" -w start >/dev/null
export PGPASSWORD=postgres
q() { psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAX "$@"; }
q -c "select version()"

# Test data: two databases, a table each. The proxy's mock control plane reads allow-lists here.
q -c "create schema neon_control_plane; create table neon_control_plane.endpoints(endpoint_id text primary key, allowed_ips text)"
for db in alpha beta; do
  q -c "create database $db"
  q -d $db -c "create table t(name text); insert into t values ('$db row')"
done

# The proxy, plain WebSocket (no TLS, so no certificate to expire), pointed at the maintenance db.
LOGFMT=text "$PROXY_BIN" --auth-backend=postgres \
  --auth-endpoint="postgres://postgres:postgres@127.0.0.1:$PGPORT/postgres" \
  --wss "127.0.0.1:$WSS_PORT" > "$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/$WSS_PORT) 2>/dev/null && break; sleep 0.2; done

cd "$(dirname "$0")"
[ -d node_modules ] || npm i -s >/dev/null
PGQUERY="${PGQUERY-}" PROXY="localhost:$WSS_PORT" SECURE=0 PGPORT="$PGPORT" node two-dbs.mjs || { tail -30 "$WORK/proxy.log"; exit 1; }

kill $PROXY_PID; run_pg pg_ctl -D "$WORK/data" -m fast stop >/dev/null
