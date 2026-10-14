# Claude CUA MCP bridge

Use an installed Codex desktop CUA runtime from Claude Code through a dedicated
Codex app-server. Each Claude session/subagent gets its own REPL context. The
bridge uses real host-created thread identifiers and does not start a Codex model
turn. This is an independent, experimental integration, not an official OpenAI
Claude plugin.

## Requirements

- macOS with a CUA-capable Codex/ChatGPT desktop app, Python 3, and its bundled Node.
- Claude Code supporting PreToolUse `updatedInput` and MCP lifecycle hooks.
- A working CUA MCP launch configuration for your installed runtime. The bridge
  does not provision browser/native backend services or grant OS permissions.

No runtime, vendor tool descriptions, credentials, user configuration, or diagnostic
transcripts are distributed. Tool schemas are collected locally during preparation.
Our code and synthetic tests are MIT licensed. Vendor components retain their own
terms. The [context profile](https://github.com/ksmkzs/cua-context-profile) is optional.

## Prepare

Export your working CUA MCP stanza into a **local, uncommitted** JSON file with
`command`, `args` and `env`. Preserve the runtime's required host/backend environment.
Do not copy another user's machine-specific settings. This file may contain private
configuration; keep it outside the repository.

```sh
python3 install.py --prepare --app /Applications/Codex.app --cua-config /path/to/local-cua.json
python3 install.py --activate --app /Applications/Codex.app
```

Use `/Applications/ChatGPT.app` when appropriate; `--app` also supports arbitrary
bundle locations and defaults to common Applications paths. Without `--cua-config`,
preparation reads an existing `codex-computer-use` entry in your Claude config.
There is no dependency on a previously installed context profile.

Preparation copies bridge code to `~/.codex/cua-claude-mcp`, generates a local
routing-integrity key, and lists the runtime's tools. It does not call a UI tool,
activate hooks, or start a model turn. Activation adds only the named MCP entry
and its hooks, preserving other settings. Start a new Claude session afterward.

Advanced paths: `--root`, `--claude-config`, and `--claude-settings`. Use the same
arguments for prepare/activate/restore. Preparation refuses an existing configured
installation; prepare in a new directory when reviewing an update. Do not delete a
live installation or its activation record to force an upgrade.

```sh
python3 install.py --restore --app /Applications/Codex.app
```

Restore reinstates the prior MCP entry or removes the entry if none existed, and
removes only the installed hooks. Changed configuration is preserved by refusing
ambiguous overwrites. No desktop app or active Claude session is forcibly restarted.

## Operation

Use `js` and `js_reset` and follow the actual first-call documentation. The optional
context profile's `cua.documentation()` is not assumed to exist. Claude's PreToolUse
hook supplies signed routing context; do not generate `_bridge_context` yourself.

Stop/StopFailure/SubagentStop/SessionEnd notify the matching runtime context.
Cancellation discards the dedicated host when necessary. An operation with an
uncertain result is never replayed automatically; reacquire UI state before acting.
The file lock serializes these bridge processes only, not desktop or human activity.

Supported approval forms/URLs are forwarded to Claude; unsupported requests are
declined. Existing host approval/sandbox settings are preserved. The bridge does
not assert that an acknowledged `turn_ended` RPC means the native cursor disappeared.
Native cursor persistence is an unresolved upstream behavior.

`events.jsonl` records IDs and outcome flags, not code, screen content, or approval
payloads. It is local and may identify sessions. Rotation is not implemented; remove
it only after all bridge sessions have ended. Never commit the state directory.

## Verification

```sh
npm test
python3 -m unittest discover -s tests
```

Tests use synthetic host/tool fixtures: routing, agent isolation, approval forwarding,
schema drift, cancellation, locks, and lifecycle acknowledgements. They do not claim
end-to-end GUI compatibility. Test a new installation with a read-only CUA observation
before relying on it for actions. Browser support depends on your configured host.

The bridge compares required runtime tool schemas against its locally captured
snapshot. Schema drift stops execution. A fresh snapshot is not proof of semantic
compatibility; review the changes and test the integration before adopting it.

## Automatic update PRs

The public production desktop appcast is checked every six hours by GitHub Actions.
A new release creates or refreshes one Draft PR with `upstream/observed.json` after
offline tests pass. No new release means no new commit/PR. This detects public releases
independently of the maintainer's Mac. Account-specific/beta releases may differ.

The PR is an actionable compatibility-review request, not a claim that an arbitrary
breaking change has been repaired. Runtime schemas, guard acceptance and activation
are not updated automatically. Native smoke tests remain manual.

Enable GitHub Actions PR creation in repository Actions settings. Only the standard
repository `GITHUB_TOKEN` is used; no API key is needed. Scheduled jobs can be delayed
or disabled under GitHub's inactivity policies. Tests on pull requests have read-only
permissions; no privileged `pull_request_target` workflow is used.

References: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[production appcast](https://persistent.oaistatic.com/codex-app-prod/appcast.xml).
