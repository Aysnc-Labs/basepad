#!/usr/bin/env bash
[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0
cd "$(dirname "$0")/../.." || exit 0

refresh_aysnc_skills_plugin() {
  local plugin=$HOME/.claude/skills/aysnc-skills
  { git -C "$plugin" fetch --quiet --depth 1 origin main && git -C "$plugin" reset --quiet --hard FETCH_HEAD; } 2>/dev/null ||
    echo "Could not refresh the Aysnc Skills plugin in $plugin"
}

refresh_aysnc_skills_plugin

state=/tmp/project-up
mkdir -p "$state"
log=$state/up.log done=$state/up.done failed=$state/up.failed pid=$state/up.pid

if [ -f "$done" ]; then
  exit 0
fi

if ! { [ -f "$pid" ] && kill -0 "$(cat "$pid")" 2>/dev/null; }; then
  rm -f "$failed"
  setsid nohup bash -c "pnpm install --frozen-lockfile && touch $done || touch $failed" >"$log" 2>&1 </dev/null &
  echo $! >"$pid"
fi

echo "Preparing this clone in the background, logging to $log. Ready when $done exists, failed when $failed does (the log says where). Wait for one before running tests or the app."
