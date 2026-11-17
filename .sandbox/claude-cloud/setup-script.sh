#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

find_repo() {
  if [ -d "$PWD/basepad" ]; then echo "$PWD/basepad"; else echo "$PWD"; fi
}

install_aysnc_skills_plugin() {
  mkdir -p "$HOME/.claude/skills"
  rm -rf "$HOME/.claude/skills/aysnc" "$HOME/.claude/skills/aysnc-skills"
  git clone --quiet --depth 1 https://github.com/Aysnc-Labs/skills.git "$HOME/.claude/skills/aysnc-skills"
}

install_tools() {
  curl -fsSL https://mise.run | sh
  export PATH=$HOME/.local/bin:$PATH
  (cd "$repo" && mise trust --yes && mise install)
  mise use -g agent-browser
}

write_exec_shims() {
  local bin
  for bin in node npm npx pnpm agent-browser; do
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$(cd "$repo" && mise which "$bin")" >"$HOME/.local/bin/$bin"
    chmod +x "$HOME/.local/bin/$bin"
  done
}

repo=$(find_repo)
install_aysnc_skills_plugin
install_tools
write_exec_shims
