# ADR 0004 — The chat view keeps concurrent sessions

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Superseded for runtime ownership by 0007/0010; the concurrency floor
and the warm pool remain product requirements (see [0016](0016-new-session-ready-at-once.md)).
Date: 2026-10-23

## Context

The chat view is the desktop's main surface. The product definition requires at
least 30 concurrent sessions: a session that is working must not block starting,
opening, or running another. Most people use one or two sessions; five is the
warm baseline; 30 is the regression floor that must never be reduced to one.

The desktop does not do that today. `chat_start` stops every previous chat
runtime before spawning a new one (`apps/desktop/src-tauri/src/chat.rs`), and
the view's New session action refuses while the current turn runs
(`chat-workspace.tsx`, "Wait for the current turn to finish before starting a new
session."). One window owns exactly one runtime.

The history is explicit. Before `a6f6044` (2026-10-20, runtime repository) the
native chat service could hold up to eight chat runtimes at once; that commit
added the drain to stop a webview-reload leak that left an orphan runtime with a
Flow attachment, and declared "one desktop view owns one runtime". The
standalone desktop repository inherited that state (`9892205`). The commit fixed
a leak by removing a capability.

The Jouzu runtime is a separate project and is not modified by this product. It
runs one session per process and has no multi-session host; a host mode was
considered and rejected because it would change another project's lifecycle,
ownership and security model. The desktop therefore multiplexes processes that
already exist.

Measured cost per runtime on the reference machine (Windows, 15.7 GB, fresh
temporary home, 8 s after start): 280.7 MB working set, 304.9 MB private. Cold
start to the first `get_state` response is 3.97 s. Five warm runtimes are about
1.4 GB; thirty are about 8.4–9.1 GB before session history and subagents.

## Decision

- The chat view supports at least 30 concurrent sessions. Every open session can
  start a turn without stopping, waiting for, or switching another session.
- Concurrency is a product invariant, not a performance target. A change that
  reduces the number of live sessions, or makes one session's turn block another
  session's start, open, or send, is a regression. No session count is hard-coded
  to one, and no path refuses a session because of a count.
- One existing runtime process per open session. The desktop owns the pool; the
  runtime protocol, the runtime repository and the TUI are untouched.
- Five idle runtime processes are warmed in the background as the baseline for
  most users. Five is a warm target, not a cap: opening a sixth session starts
  another process.
- The entry session is opened during the existing app loading. After loading,
  opening a session from the warm pool is immediate and shows no second loading.
  A cold session starts its own process (about 4 s); the view shows the disk
  preview, the composer stays usable, and a send is queued rather than blocked.
- The visible session is a view choice. Switching between warm sessions does not
  call `switch_session`, reload history, or restart a runtime.
- Each session's runtime is a separate crash domain. One process failing marks
  that session interrupted; the others continue.
- Prompt drafts are desktop UI state, not runtime state. A draft belongs to its
  workspace and session (or the new-session slot), survives a workspace switch,
  and is cleared only by a successful send.
- Session status comes from each live connection. A session running in a
  terminal or console process stays unmarked because marking it would require a
  runtime change; the activity record remains a runtime gap.
- A webview reload releases the previous page's handles by generation and a poll
  reaper. It never stops other live sessions to clean up.

## Consequences

- `chat_start` no longer retires other sessions and has no product count limit.
  Stale-generation cleanup and a poll reaper replace the drain.
- The webview needs one connection per live session. The IPC must be multiplexed
  (one poll for the pool), not one timer per connection: thirty connections at
  the current 5/30 ms cadence are 1,000–6,000 polls per second.
- The 64 MB per-session record ceiling is a cap, not an allocation; the pool
  needs a measured shared ceiling, not 30 × 64 MB and not an arbitrary lower
  per-session value.
- Memory is a hardware cost, reported and measured, never used to refuse a
  session or lower the target: five warm ≈ 1.4 GB, thirty concurrent ≈ 9 GB.
- MCP remains per process. The runtime is not modified, so clients and stdio
  servers are not shared; a local HTTP gateway is a later option.
- Workspace switching no longer restarts the runtime. The pool lives above the
  workspace view, and drafts survive the view change.
- Session status comes from each live connection; an activity record for external
  terminal sessions remains a runtime gap.

## Amendment 2026-10-27

The capability stays as decided: no path refuses a session, and nothing may
return to a one-runtime view. The **gate** is five sessions, not thirty. Five
open sessions, each able to run a turn, is what the five-session gate must prove;
thirty is a capacity target, reported only when a fixture or a machine sized for it
exists. The one-session lock this ADR removed is guarded directly by the product
behavior.
