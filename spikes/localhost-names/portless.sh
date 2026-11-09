#!/usr/bin/env bash
# Linux as root (ubuntu:24.04) or macOS as a user: portless serving two worktree-style names over plain HTTP.
# Usage: docker run --rm -v "$PWD:/spike" ubuntu:24.04 /spike/portless.sh
#        SPIKE="$PWD" ./portless.sh   (macOS)
set -uo pipefail
if [ "$(uname)" = Linux ] && [ "$(id -u)" = 0 ]; then
  apt-get update -qq && apt-get install -y -qq curl ca-certificates git >/dev/null
fi
command -v mise >/dev/null || { curl -fsSL https://mise.run | sh >/dev/null; }
export PATH="$HOME/.local/bin:$PATH"
SPIKE="${SPIKE:-/spike}"
mise use -g -q node@24
eval "$(mise env -s bash)"
rm -rf /tmp/app && cp -r "$SPIKE/app" /tmp/app && (cd /tmp/app && npm i -s >/dev/null)
npm i -g -s portless >/dev/null
echo "--- version"; portless --version
echo "--- help"; portless --help 2>&1 | head -40
node /tmp/app/server.mjs 4100 >/dev/null & node /tmp/app/server.mjs 4342 >/dev/null &
sleep 1
echo "--- start proxy: plain HTTP on a high port"
portless proxy start --no-tls --port 8088 2>&1 | tail -5 || true
sleep 1
echo "--- aliases"
portless alias app.shop 4100 2>&1 | tail -2
portless alias app.pr-42.shop 4342 2>&1 | tail -2
sleep 2
echo "--- list"; portless list 2>&1 | tail -10
echo "--- json?"; portless list --json 2>&1 | head -5
echo "--- curl"
for i in 1 2 3; do
for h in app.shop.localhost app.pr-42.shop.localhost; do curl -sS --max-time 3 http://$h:8088/; echo; done; sleep 1; done
curl -sv --max-time 3 http://app.shop.localhost:8088/ 2>&1 | grep -i '^< connection'
echo "--- node websocket (no manual /etc/hosts)"
grep localhost /etc/hosts || true
for i in 1 2 3; do for h in app.shop.localhost app.pr-42.shop.localhost; do node /tmp/app/ws-check.mjs ws://$h:8088/ws; done; done
