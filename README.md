# claude-cua-mcp

[日本語](README.ja.md)

Use the Computer Use (CUA) runtime of the installed Codex desktop app from Claude Code.
It is not an OpenAI or Anthropic product.

The runtime inside the desktop app is an ordinary MCP stdio server. This repository starts that same,
unmodified server for Claude Code, with the launch settings the desktop app writes for itself:

```
Claude Code ── MCP (stdio) ── launch ── [cua-proxy, if installed] ── node_repl (inside ChatGPT.app / Codex.app)
                                                                            └─ the app's own Computer Use service
```

There is no bridge process, no copy of the runtime and no saved schema: the settings are read from the
desktop app's own plugin configuration at every start, so an app update needs nothing done here.

## What you get

- The tools the Codex app enables for itself: `js`, `js_reset`, `turn_ended`.
- **Approvals as in Codex.** "Allow Computer Use to use …?" arrives as a standard MCP elicitation and is
  shown by Claude Code. Nothing is approved on your behalf.
- **The same limits.** Apps the runtime refuses (terminals, the desktop app itself, …) stay refused; that
  decision is made by the vendor's service, which this does not touch.
- Desktop apps only by default. The browser surfaces (the in-app browser, the Chrome plug-in) belong to
  the Codex app's own window and conversation. `CLAUDE_CUA_SURFACES=browser,computer` passes them through
  if you want to try.

With [cua-context-profile](https://github.com/ksmkzs/cua-context-profile) installed, the launcher runs its
proxy in front of the runtime: shorter reference text, a session identity for the runtime, and, with
[safari-window-mcp](https://github.com/ksmkzs/safari-window-mcp), a Safari window of the session's own.
Both are optional.

## What this depends on

The runtime in current desktop app builds (checked on 26.1103) controls apps only when the program that
starts it is signed by OpenAI; started from anything else it can list apps but fails to bind one ("Sky
Computer Use native pipe startup failed"). The launcher therefore starts it from the Node that ships inside the app. That is how it works today, not a
promise: if the vendor narrows this, this stops working and the remaining route is the app's documented `codex app-server` interface.

## Install

Requires macOS, the Codex desktop app opened at least once with Computer Use enabled, and Claude Code.

```sh
sh install.sh                 # add the MCP server "codex-computer-use", a turn-end hook and one deny rule
sh install.sh install --replace   # replace an existing server of the same name
sh install.sh uninstall
```

The installer uses `claude mcp add` for the server and edits `~/.claude/settings.json` for two things only
(a backup is written to `~/.local/share/claude-cua/backup/` first):

- `Stop` / `StopFailure` hooks that call `turn_ended`, so the runtime releases its on-screen cursor when a
  turn ends, as it does in Codex;
- a deny rule for `js_add_node_module_dir`, a tool the Codex app never shows to a model.

Start a new Claude Code session afterwards.

## When the desktop app is updated

- **The Codex app does not have to be running.** The launcher starts a new runtime, and the runtime starts the Computer Use service itself (checked with 26.1111).
- **A session that was running before the update must reconnect.** A runtime started before the app was updated can no longer reach the new version's service: app calls fail with "Sky Computer Use native pipe startup failed" (seen on the update from 26.1105 to 26.1111). Reconnect this server from `/mcp` in Claude Code, or start a new session. With cua-context-profile installed, the error comes with a note saying so.
- **Checking after an update.** `sh check.sh` checks, against the app on this Mac, that a new runtime starts and answers, that the tools are the ones the app enables for itself, that apps are listed without an error and, with cua-context-profile, that the filter loads, the shortened documentation is returned and the entry points are still in it. `sh check.sh --record` keeps the result in `upstream/verified.json`.
- GitHub Actions (`upstream.yml`) records new public releases every six hours and opens a draft pull request for review. CI cannot run the macOS app, so compatibility is checked by running `check.sh` on a Mac.

## Notes

- One Claude Code session is one runtime session; its subagents share it.
- Operating-system permissions belong to the app that runs Claude Code (for example the terminal).
- `CLAUDE_CUA_RUNTIME=/path/to/node_repl` selects a specific runtime; `CODEX_APP=/path/to/App.app` a
  specific desktop app.
- Whether a given use fits the terms of the software involved is for you to judge. This starts the vendor's
  server as shipped and leaves its approvals and restrictions in place.

## Tests

```sh
npm test
python3 -m unittest discover -s tests      # update watcher
```

MIT licence.
