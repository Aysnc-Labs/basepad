#!/bin/bash
# Setup script for a Claude Code cloud environment: paste this file's contents into the environment's
# "Setup script" field on claude.ai/code. It runs as root when the environment's cache is built (first
# session, a change to this script or the network list, or about every 7 days), after the repository is
# cloned, so it installs tools only: nothing here may leave a process running. The SessionStart hook
# (session-start.sh) prepares the clone itself.
#
# Network access: the default list (which has github.com), plus mise.run, mise-versions.jdx.dev,
# nodejs.org, conda.anaconda.org and repo.prefix.dev (Postgres and pgvector through mise's conda backend). Repository: Aysnc-Labs/basepad.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# The script starts in the folder the repository is cloned into, or in the clone itself.
repo=$PWD/basepad
[ -d "$repo" ] || repo=$PWD

# The Aysnc Skills plugin. Cloud sessions install no plugins, but a folder with .claude-plugin/plugin.json
# under ~/.claude/skills loads as one (aysnc-skills@skills-dir), prefix and agents included. The
# repository is public, so a plain clone reaches it; the SessionStart hook refreshes it, since a reused
# cache can be days old. The old aysnc link goes too, so the plugin loads once.
mkdir -p "$HOME/.claude/skills"
rm -rf "$HOME/.claude/skills/aysnc" "$HOME/.claude/skills/aysnc-skills"
git clone --quiet --depth 1 https://github.com/Aysnc-Labs/skills.git "$HOME/.claude/skills/aysnc-skills"

# mise, then the Node 24 that mise.toml pins, put on PATH through ~/.local/bin, which comes before the image's
# own Node on PATH. basepad installs Postgres and pitchfork itself, through mise, on first `up`.
curl -fsSL https://mise.run | sh
export PATH=$HOME/.local/bin:$PATH
(cd "$repo" && mise trust --yes && mise install)
# An exec script, not a symlink: mise's npm finds npm-cli.js relative to its own path.
for bin in node npm npx; do
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$(cd "$repo" && mise which $bin)" >"$HOME/.local/bin/$bin"
  chmod +x "$HOME/.local/bin/$bin"
done
