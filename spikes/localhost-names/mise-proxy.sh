#!/usr/bin/env bash
# Linux as root (ubuntu:24.04) or macOS as a user: mise's proxy on plain HTTP 8088 for two worktrees.
# Usage: docker run --rm -v "$PWD:/spike" ubuntu:24.04 /spike/mise-proxy.sh
#        SPIKE="$PWD" ./mise-proxy.sh   (macOS; writes ~/.config/pitchfork/config.toml)
set -euo pipefail
if [ "$(uname)" = Linux ] && [ "$(id -u)" = 0 ]; then
  apt-get update -qq && apt-get install -y -qq curl ca-certificates git >/dev/null
fi
command -v mise >/dev/null || { curl -fsSL https://mise.run | sh >/dev/null; }
export PATH="$HOME/.local/bin:$PATH"
SPIKE="${SPIKE:-/spike}"
mise use -g -q node@24
eval "$(mise env -s bash)"
rm -rf /tmp/app && cp -r "$SPIKE/app" /tmp/app && (cd /tmp/app && npm i -s >/dev/null)

# Proxy settings in pitchfork's own config, so every mise call agrees.
mkdir -p ~/.config/pitchfork
printf '[settings.proxy]\nenable = true\nhttps = false\nport = 8088\n' > ~/.config/pitchfork/config.toml

W="${TMPDIR:-/tmp}/work"; rm -rf "$W"; mkdir -p "$W/shop" && cd "$W/shop" && git init -q
git config --global user.email s@example.com && git config --global user.name spike
cat > mise.toml <<'TOML'
[settings]
experimental = true

[daemons.app]
run = "exec node /tmp/app/server.mjs $APP_PORT"
port = { auto = true, base = 4100 }
TOML
git add -A && git commit -qm init && git worktree add -q ../pr-42
for w in shop pr-42; do (cd "$W/$w" && mise trust -q && mise daemons start 2>&1 | grep -E 'started|http' ); done

echo "--- curl (resolves *.localhost itself)"
for h in app.shop.localhost app.pr-42.shop.localhost; do curl -fsS http://$h:8088/; done
echo "--- node websocket, no /etc/hosts entries"
node /tmp/app/ws-check.mjs ws://app.shop.localhost:8088/ws || echo "FAILED without /etc/hosts (expected on minimal Linux)"
echo "--- node websocket, after /etc/hosts entries"
if [ "$(uname)" = Linux ]; then
  echo "127.0.0.1 app.shop.localhost app.pr-42.shop.localhost" | ${SUDO:-} tee -a /etc/hosts >/dev/null
fi
for h in app.shop.localhost app.pr-42.shop.localhost; do node /tmp/app/ws-check.mjs ws://$h:8088/ws; done
echo "--- routes"
(cd "$W/pr-42" && mise daemons ls --json | grep -E '"(host|url|status)"')
