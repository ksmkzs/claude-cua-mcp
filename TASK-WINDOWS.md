# Task windows through the CUA bridge

The bridge owns the operation, not the JavaScript caller. It forwards the original
CUA `js` and `js_reset` arguments without rewriting the program, in a dedicated
app-server thread for the signed client/session/agent context. Claude and Codex
use the same implementation and global operation lock.

On the first literal Safari reference (the app name or bundle ID in code), the
bridge creates a new owned window. After that, **every call in that context**
selects the original window in background Safari and checks its AX main-window
identity immediately before and after forwarding. Saved app variables are allowed.
There is no per-call allowlist of JavaScript programs or non-Safari apps.

The initial detection is a convenience for ordinary `cua.getApp("Safari")` calls,
not a semantic JavaScript sandbox: computed/obfuscated names that contain neither
the Safari name nor bundle ID are not recognized. Start Safari work with the
literal app name or bundle ID. Once bound, reselection does not depend on what the
next code string contains. A context that has never referenced Safari forwards
calls without creating or selecting a Safari window.

## Ownership and lifetime

The private `owned-windows.json` is keyed by a digest of client kind, session ID
and agent ID. It stores the manager's owner/capability and UUID; it does not store
page content, titles or URLs. It is written atomically while holding the shared
operation lock. The same context can recover after an MCP bridge restart while
the external window manager and original Safari process remain alive.

The external manager retains the original AX reference and Safari process
generation. If that identity is lost, the bridge refuses to adopt a window by
title, URL or numeric ID and does not automatically create a replacement.
REPL variables do not survive an app-server restart; begin with a fresh observation.

Before minimizing, the host samples editable field values inside the exact owned AX window.
Background Safari may expose no application-level focused element, so the
bounded traversal includes page input fields and the address field.
It requires at least two equal values, at least one second of observation and
0.8 seconds without change, with an eight-second deadline. Values are compared
in memory and never logged. If editable values cannot be observed, secure fields are present, traversal
exceeds its bounds, or values do not settle,
parking is deferred and the CUA result carries a warning. This is a quiet-value
heuristic, not proof that an arbitrary application's input queue is empty. The
original in-call AX observation is not rewritten: it can still show an earlier
partial value; a subsequent observation sees the state after this settle phase.
Every completed call then parks its exact owned window when these conditions
hold and releases the lease. If the person is using Safari, parking is deferred rather than changing
their window order. An input timeout/cancellation first stops the dedicated
executor, then settles the window lease and finally releases the shared lock.
No TTL unlocks an action that may still be running. Abrupt process death can
quarantine the manager; this requires inspection, not automatic replay.

Safari in the foreground causes a bounded wait of up to 30 seconds before
forwarding. The bridge never activates another app to force Safari into the
background. Once a context is Safari-bound, this wait and the existing serial
queue apply to its calls even when the next call operates another app.

## Remaining focus and clipboard race

Checks before and after a call detect a different main window at those times.
They cannot prevent a person switching windows during a native input operation,
undo input already delivered, or detect every switch-away-and-back between the
checks. Do not use Safari interactively while the bridge is operating it.
Clipboard-based paste also shares the system clipboard. Keep input calls short;
an error after dispatch is not permission to replay the action.

If CUA completes but parking fails, the result retains the original CUA output
and appends the cleanup error. It is marked as an error so the caller stops,
without hiding that the native operation may already have succeeded.

In the owned local fixture, a single native click did not focus the page input;
a documented double-click followed by `typeText` did. This is recorded as a CUA
interaction observation, not handled by automatic click or input replay. Inspect
fresh state when native input does not have the expected effect.

## Permission and lifecycle boundaries (0.2.1)

The observed startup hang was inside `AEDeterminePermissionToAutomateTarget`,
called synchronously before window creation; no permission dialog was visible.
The OS-internal reason is unproven. The host now waits for Safari readiness and
addresses its running process ID, then performs the non-prompting permission
query in a separate process. A five-second deadline kills that probe before
any window creation or CUA forwarding. A broker transport timeout kills its
private host process group and marks that host failed; it cannot resume late.
No native action is automatically replayed, and no permission setting changes.

Claude `SessionEnd` and `SubagentStop` finish the matching executor context and
close only its recorded owned window under the shared operation lock. A single
ordinary (non-pinned) tab is required; globally shared pinned tabs do not count
as extra ordinary tabs. Additional ordinary tabs, uncertain executor shutdown,
lost ownership, or close failure retain a private `cleanup.status = manual`
receipt. Repeated lifecycle events do not replay a failed close. Claude `Stop`
does not close the task window. Scope digests allow cleanup after MCP restart.

## Codex automatic close (0.2.2)

Codex `Stop` closes the current turn's owned window when an answer finishes.
`SubagentStop` closes only the identified child's window. The hook's parent
session ID is not treated as the child's tool-session ID: the bridge matches
the child session or the authenticated parent/agent pair, never all siblings.
Both events call the hidden `codex_lifecycle` MCP tool. These two new hook
definitions require Codex's normal trust review, followed by MCP reconnection.
The installer preserves existing hook trust and does not approve the new hooks.

Cleanup retains the single-ordinary-tab and ownership checks described above.
Turn digests prevent an old `Stop` from closing a newer turn's window. Saved
REPL references are discarded before closing; when another bridge process
closes a child's window, that child's next call rejects stale references before
forwarding any CUA action. Begin further Safari work with a fresh
`cua.getApp("Safari")` call. A review hook may continue after `Stop`; it also
starts with a new window rather than reopening the closed one.

Codex `SessionEnd` does not support MCP tool hooks and is not registered here.
The normal answer/subagent completion hooks perform cleanup; application
crashes or abrupt shutdown can still leave a parked window for manual cleanup.
See [Codex hook lifecycle and trust](https://learn.chatgpt.com/docs/hooks).

## Client routing

### Current CUA js schema (0.2.3)

`js` accepts either code (with optional title/timeout) or a
`completion_summary`-only report. The bridge forwards the latter unchanged,
without selecting or parking a Safari window. It does not treat the report as
a `Stop` event; the normal lifecycle hook still owns window closure. Routing
metadata is admitted in each strict `oneOf` schema branch and removed before
forwarding. Mixed code/report requests are rejected before dispatch.

When upgrading after a CUA schema change, use `--refresh-tools` during
preparation to obtain current schemas without UI calls. To use a newly tested
documentation profile, supply `--profile-wrapper PATH`; preparation verifies
its upstream guards before changing the staged launch configuration. The
previous runtime remains available for rollback. Do not manually edit the
installed schema snapshot or guard hashes to suppress a compatibility error.

Claude's existing PreToolUse hook supplies signed context. The upgraded bridge
continues to reject missing, invalid or replayed context before executing CUA.
The existing Claude lifecycle hooks still target `codex-computer-use`.

Codex uses the `task_cua` MCP entry and `codex-hook.mjs`. This hook supplies signed
context using session/turn/tool-use identity and denies direct built-in CUA calls
on matching hook paths. The server also refuses unsigned `task_cua` calls, so
skipping or failing the signing hook does not execute those calls.

New Codex hooks require the user's normal hook-trust review. The installer does
not edit trust hashes or bypass review. A missing/untrusted hook blocks the new
bridge through its missing signature; it does not prove all built-in or alternate
tool paths are disabled. Use the bridge, and verify actual hook coverage on the
client before claiming automatic redirection.

When a Codex PreToolUse event omits an agent ID, routing uses its parent session
context. Such subagents share that task's window under the common lock; distinct
per-agent windows are only asserted when a distinct authenticated agent ID is
supplied. This must be checked on the actual client rather than inferred from
configured hooks.

Existing running MCP processes keep their old code and require reconnection.
Upgrading files/registration does not silently replace a running session.

## Prepare, register, restore

Use `upgrade_task_windows.py --prepare` with a new immutable `--root` and
`--socket`. It reuses the existing CUA launch configuration and routing key,
compiles the independent window host, and writes a hash manifest. No vendor
module, trusted-code rule, OS permission, or model setting is changed.

After validation, `--activate --root PATH` registers both clients, preserves
unrelated configuration and stores a private rollback receipt. It leaves Codex
hook trust to the user. `--restore --root PATH` restores the exact prior
registration only when current files still match this installation's receipt;
concurrent changes cause refusal rather than overwrite.

## Owned-window maintenance

Run the installed `window-maintenance.mjs --list` to list context hashes and
recorded UUIDs without observing Safari. `--close HASH` closes only that owned
record, under the operation lock, after the manager checks its original AX
reference, process generation, UUID and unpinned selected tab. It never accepts a
title, URL or numeric window ID as ownership. A failed/uncertain close is not
automatically retried.

Licensed literature workflows continue to use their existing dedicated route
and policy. This bridge is not a replacement for those site-policy hooks.

## Validation status

Offline tests cover signed client identity, cross-context isolation, saved app
references after bridge restart, foreground waiting, changed-main-window failure,
executor-before-unlock ordering, preservation of completed results after cleanup
failure, and configuration preservation/rollback.

Live verification uses only owned loopback fixtures and refuses approval requests.
Keep the live receipts separate from synthetic tests; do not infer concurrent
human-input safety from a sequential successful input test.

On 2026-10-20, the real hook → MCP bridge → app-server → CUA fixture run
confirmed separate Claude/Codex windows, native text input, reuse of a saved app
reference, and restoration of both original windows and values after an MCP
restart. This used a test harness invoking the real hook executables; actual
Codex desktop hook delivery and trust were pending at that point; the actual
client result below supersedes that limitation.

On 2026-10-21, the user confirmed actual Claude connection, background input,
agent separation, parking and manual closure on 0.2.0-r2. Actual Codex parent
and two subagents also received three different UUIDs through the real client
hook/MCP path. The 0.2.1 permission watchdog was fault-tested with a hung worker
and verified to terminate without continuing to a UI action.

The 2026-10-21 checks passed 24 Node tests and 39 Python tests, including
permission-worker termination, host transport cancellation, lifecycle cleanup,
manual cleanup receipts, and upgrade preservation of existing hook trust.
The v3 live fixture confirmed `SubagentStop` closed the exact owned window and
removed its registry record. A computer restart interrupted the v4 fixture
before its 17-character input test; its old window binding must not be reused
or reconstructed from the visible window title.

After the reboot, v5 on `0.2.1-r2` created fresh owned contexts. One 17-character
input was observed in full in a subsequent call, with matching `parked: true`
audit results. `SubagentStop` for A and `SessionEnd` for B each reported
`closed: true` and removed only their matching ownership record. These are
real Safari/CUA tests driven through the hook/MCP harness, not proof of actual
Claude client delivery of those new lifecycle events. The lost v4 binding was
retained with a manual cleanup receipt; no restored window was adopted.

At that point both client registrations pointed to `~/.local/share/cua-task-bridge/0.2.1-r2`.
Existing hook definitions and trust were preserved. Existing MCP connections
still require reconnection to load this version.

On 2026-10-30, 0.2.2 passed 30 Node tests and 15 Python tests for the bridge and
installer. A real Safari/CUA fixture with synthetic Codex lifecycle inputs
confirmed that `SubagentStop` closes B while A remains byte-for-byte unchanged
in the registry, then `Stop` closes A. Both ownership records were removed.
Both clients were registered to `~/.local/share/cua-task-bridge/0.2.2` with
existing signer/trust state preserved. The new Codex `Stop`/`SubagentStop`
hooks still need user trust review and MCP reconnection; actual desktop
lifecycle delivery remains to be verified after that review.

On 2026-11-05, app 26.1029.61003 (build 24614) required the new strict js union.
Bridge 0.2.3 with profile 0.4.0 passed 32 bridge Node, 15 bridge Python,
18 profile Node and 27 Safari Python tests, plus wrapper fallback checks.
The real CUA harness confirmed both profile markers, Codex 17-character input,
parking, completion-summary forwarding without a window operation, and Stop
closure. Claude creation, completion-summary forwarding and SubagentStop
closure also passed. An additional Codex window creation timed out (-1712);
its unbound record was retained for manual inspection without replay.
The host now reports failures from the create request through validation as
CREATION_UNCERTAIN; a no-UI fault-injection test covers that path. This does
not claim to resolve Safari's underlying Apple Event timeout.

Both clients are registered to `~/.local/share/cua-task-bridge/0.2.3-r3`,
using `~/.codex/cua-context-profiles/0.4.0/node-repl`. Hook definitions and
trust are unchanged. Reconnect existing MCP clients; the desktop profile
override applies at the next normal app launch. Older runtimes remain for rollback.
