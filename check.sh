#!/bin/sh
# Check that the installed Codex desktop app works through the launcher (see scripts/check_app.mjs).
# Run it after the desktop app was updated:  sh check.sh [--record]
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
for app in "${CODEX_APP:-}" /Applications/ChatGPT.app /Applications/Codex.app "$HOME/Applications/ChatGPT.app" "$HOME/Applications/Codex.app"; do
  [ -n "$app" ] && [ -x "$app/Contents/Resources/cua_node/bin/node" ] || continue
  CODEX_APP=$app exec "$app/Contents/Resources/cua_node/bin/node" "$here/scripts/check_app.mjs" "$@"
done
echo "claude-cua: the Codex desktop app (ChatGPT.app or Codex.app) was not found; set CODEX_APP to its path" >&2
exit 127
