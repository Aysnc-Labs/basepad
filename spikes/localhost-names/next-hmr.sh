#!/usr/bin/env bash
# Runs inside ubuntu:24.04 as root: next dev behind mise's proxy; HMR socket through the hostname.
set -euo pipefail
SPIKE="${SPIKE:-/spike}"
apt-get update -qq && apt-get install -y -qq curl ca-certificates git >/dev/null
curl -fsSL https://mise.run | sh >/dev/null
export PATH="$HOME/.local/bin:$PATH"
mise use -g -q node@24
eval "$(mise env -s bash)"
rm -rf /tmp/app && cp -r "$SPIKE/app" /tmp/app && (cd /tmp/app && npm i -s >/dev/null)
mkdir -p ~/.config/pitchfork
printf '[settings.proxy]\nenable = true\nhttps = false\nport = 8088\n' > ~/.config/pitchfork/config.toml
mkdir -p /work/web/app && cd /work/web && git init -q
npm init -y >/dev/null && npm pkg set type=module && npm i -s next@latest react@latest react-dom@latest >/dev/null
printf 'export default function Page() { return <h1>hello</h1> }\n' > app/page.jsx
printf 'export default function L({ children }) { return <html><body>{children}</body></html> }\n' > app/layout.jsx
cat > mise.toml <<'TOML'
[settings]
experimental = true

[daemons.web]
run = "exec npx next dev -p $WEB_PORT"
port = { auto = true, base = 4200 }
TOML
mise trust -q && mise daemons start 2>&1 | grep -E 'started|http'
echo "127.0.0.1 web.web.localhost" >> /etc/hosts
for i in $(seq 1 60); do curl -fs http://web.web.localhost:8088/ >/dev/null && break; sleep 1; done
echo "--- page"; curl -sS http://web.web.localhost:8088/ | grep -o '<h1>[^<]*</h1>' || mise daemons logs web 2>&1 | tail -15
echo "--- hmr"; DEBUG=1 node /tmp/app/hmr-check.mjs ws://web.web.localhost:8088/_next/hmr?id=spike /work/web/app/page.jsx || true
npx next --version
echo "--- hmr direct to next's port (control)"
DEBUG=1 node /tmp/app/hmr-check.mjs ws://localhost:4200/_next/hmr?id=spike /work/web/app/page.jsx || true
