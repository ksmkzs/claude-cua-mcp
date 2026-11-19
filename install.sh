#!/bin/sh
# install.sh [install [--replace] | uninstall] [--name NAME]
# Registers the Codex desktop app's Computer Use runtime as an MCP server in Claude Code.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
for app in "${CODEX_APP:-}" /Applications/ChatGPT.app /Applications/Codex.app "$HOME/Applications/ChatGPT.app" "$HOME/Applications/Codex.app"; do
  [ -n "$app" ] && [ -x "$app/Contents/Resources/cua_node/bin/node" ] || continue
  exec "$app/Contents/Resources/cua_node/bin/node" "$here/install.mjs" "$@"
done
echo "claude-cua: the Codex desktop app (ChatGPT.app or Codex.app) was not found; set CODEX_APP to its path" >&2
exit 127
