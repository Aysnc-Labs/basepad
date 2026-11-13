#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json) for Claude Code cloud sessions. Prepares a fresh clone in
# the background so the session starts at once, and only restarts services on a resume, since a cloud
# VM keeps files but not processes. Does nothing on a laptop.
# A cloud session runs as root on Linux: basepad's own tests then cover the Postgres service user and
# the proxy binding port 443 itself, which a laptop cannot. This hook installs and builds; it starts
# nothing, since tests start their own sandboxed supervisors. Run `npm run check` once it is done.
[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0
cd "$(dirname "$0")/../.." || exit 0

# The Aysnc Skills plugin that setup-script.sh cloned, brought up to date: a reused environment cache
# can be days old. Fetch and reset rather than pull, so a force-pushed main still lands.
plugin=$HOME/.claude/skills/aysnc-skills
{ git -C "$plugin" fetch --quiet --depth 1 origin main && git -C "$plugin" reset --quiet --hard FETCH_HEAD; } 2>/dev/null || echo "Could not refresh the Aysnc Skills plugin in $plugin"

state=/tmp/project-up
mkdir -p "$state"
log=$state/up.log done=$state/up.done failed=$state/up.failed pid=$state/up.pid

if [ -f "$done" ]; then
  exit 0
fi

# A resume while the first run is still going leaves it be.
if ! { [ -f "$pid" ] && kill -0 "$(cat "$pid")" 2>/dev/null; }; then
  rm -f "$failed"
  setsid nohup bash -c "{ npm ci; } && touch $done || touch $failed" >"$log" 2>&1 </dev/null &
  echo $! >"$pid"
fi

echo "Preparing this clone in the background, logging to $log. Ready when $done exists, failed when $failed does (the log says where). Wait for one before running tests or the app."
