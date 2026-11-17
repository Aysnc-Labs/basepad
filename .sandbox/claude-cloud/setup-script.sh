#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
repo=$PWD/basepad
[ -d "$repo" ] || repo=$PWD

mkdir -p "$HOME/.claude/skills"
rm -rf "$HOME/.claude/skills/aysnc" "$HOME/.claude/skills/aysnc-skills"
git clone --quiet --depth 1 https://github.com/Aysnc-Labs/skills.git "$HOME/.claude/skills/aysnc-skills"

curl -fsSL https://mise.run | sh
export PATH=$HOME/.local/bin:$PATH
(cd "$repo" && mise trust --yes && mise install)
mise use -g agent-browser
for bin in node npm npx agent-browser; do
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$(cd "$repo" && mise which $bin)" >"$HOME/.local/bin/$bin"
  chmod +x "$HOME/.local/bin/$bin"
done
