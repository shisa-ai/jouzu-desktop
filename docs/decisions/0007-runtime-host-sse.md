# 0007 — The UI subscribes to an independent runtime host over SSE

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted; the event and snapshot shapes are now defined in [`../design/host-layer.md`](../design/host-layer.md) §7
Date: 2026-10-30
Related: 0003, 0008, 0009, 0010, `spec/03-host.md`

> Wire-naming note (2026-11-03): the protocol sketch and the prompt addendum below
> are conceptual. The normative event names and shapes are in
> `contracts/host-ui-v1.md` §8: `session.status` (not `session.state`),
> `approval.requested/resolved` and `question.requested/answered/cancelled` (not
> `prompt.open/resolve`), and an SSE comment heartbeat (not a sequenced event).

## Context

Today the WebView is both the UI and the owner of runtime sessions:

- the page calls `chat_start` / `chat_poll` over Tauri IPC;
- a per-page `pageGeneration` tags the polling handles;
- a page load calls `chat_release_generation`, which stops every session from
  the previous generation and terminates its Node job tree.

Consequences observed:

- refreshing the UI kills running turns, subagents and background work;
- the boot path reports Node status by spawning `node --version`, which can hang
  the UI behind a Windows loader dialog;
- polling makes latency and CPU scale with the view;
- session lifetime, transport ownership and UI lifecycle are coupled.

The product expectation: the UI is a **view**; refresh, window recreation and
future remote clients must not affect the runtimes.

## Decision

A long-lived **runtime host** owns Node runtimes, session buffers, tool events
and background work, and **serves the web UI itself**. The desktop shell loads
that origin; a remote browser is the same client (ADR 0008). The UI is a
**subscriber** over the same protocol a remote client uses.

### Process and lifetime

- The host is a **child of the desktop app** (not an OS service). It runs inside
  an app-owned job object, so an app crash cannot leave a zombie host.
- The window closes to the **system tray** by default; the app and host keep
  running.
- **Tray quit stops everything immediately**: no warning, interrupt running
  work, kill the host and its job tree, remove the discovery file.
- Page reloads and window recreation never stop the host or a session.

### Transport

- Commands: HTTP `POST` / `GET` with JSON.
- Events: **SSE** (`GET /v1/sessions/{id}/events`), resumed with
  `Last-Event-ID`.
- Bind `127.0.0.1` on an **ephemeral port** (decision: not a named pipe). The
  host writes `host.json` (pid, port, token, version, startedAt) under the
  managed root; the app attaches, and replaces a stale file.
- HTTP is chosen instead of a pipe **because remote access is a requirement**:
  the same endpoints must be reachable by a remote client later. Do not bake a
  pipe-only abstraction that remote cannot use.
- Remote exposure is off by default. A later remote mode adds TLS, pairing/
  device tokens and an explicit bind address; the protocol and auth abstraction
  must allow it now (bearer token passed as `Authorization`, versioned paths).

### Sessions

- A session is owned by the host, keyed by workspace path + session key; it is
  independent of any page.
- A page attaches with a cursor; a reload attaches again and resumes.
  Detaching only stops delivery to that page.
- Only the host stops a runtime: explicit stop, idle TTL with no subscriber and
  no running work, or app quit.

### SSE resume and replay (decision)

- Per session, events carry a monotonic `id` (sequence number).
- The host keeps a **bounded ring buffer**: last **5,000 events or 2 MiB of
  serialized payload per session**, whichever is smaller. Heartbeat every 15 s
  (`: keep-alive` comment or `heartbeat` event).
- If a client's `Last-Event-ID` is older than the buffer head, the host sends a
  `session.snapshot` event (current projection: messages, tool state, running
  flag, cursor) and then continues live. This is the only resync path; no full
  history in the buffer.
- A slow subscriber gets a bounded per-client queue (1 MiB); if it overflows it
  is disconnected and reconnects via snapshot.
- Idle runtime reaping: a session with no subscriber and no running work may be
  stopped after **15 minutes**; its JSONL remains on disk, and a later attach
  creates a fresh runtime. Running work is never reaped.

### Quit

Tray quit is the only "stop all" path. It stops the host, which terminates the
job tree; no zombie processes, no warning dialog.

Contract: `docs/contracts/host-ui-v1.md` (the UI-facing surface; this ADR owns the decision).

## Protocol sketch

```text
GET  /v1/health                    { version, uptime, sessions }
GET  /v1/sessions                  [ { id, path, state, running } ]
POST /v1/sessions                  { path, key } -> { sessionId, cursor }
GET  /v1/sessions/{id}/events      SSE; Last-Event-ID / ?after=
POST /v1/sessions/{id}/messages    { text, attachments }
POST /v1/sessions/{id}/interrupt
POST /v1/sessions/{id}/stop
```

Events: `session.state`, `session.snapshot`, `message.delta`, `message.done`,
`tool.start`, `tool.result`, `turn.end`, `heartbeat`, `error`.

## Consequences

Positive: reload/window changes cannot stop work; the UI is a pure view; remote
mode is a client of the same API; polling disappears; the host is testable with
`curl`.

Negative: a second process to package/update/watch; port/token discovery; host
crash and version-skew handling; both binaries must ship and update together.

## Alternatives

- **In-process Rust host + SSE**: fewer moving parts, but the "independent of
  view" guarantee is weaker and remote still needs a network boundary.
- **Keep Tauri IPC with detach instead of stop**: fixes the reload-stops-work
  case minimally, but
  keeps polling and cannot serve remote.
- **Named pipe**: simpler local auth, rejected because remote is a requirement.

## Migration

1. Protocol + host skeleton (health/sessions/token/single instance).
2. Move `ChatService` ownership (process, buffers, events) into the host; SSE.
3. Replace `chat-connection` polling with an SSE client; attach/resume; remove
   generation-based stopping.
4. Packaging: host binary, app-child start/stop, tray quit, crash/restart,
   orphan cleanup, updater ships both.
5. Parity tests; keep a flag until green; then delete the polling path.

## Open questions

None for the local scope. Remote (TLS, pairing, relay) is a later ADR that must
reuse this protocol and auth boundary.

## Remote control addendum (2026-10-30)

Remote control is designed with the transport, not after it.

- **Prompts are first-class host events.** Tool reviews, extension dialogs and
  user questions become `prompt.open` / `prompt.resolve` events with a prompt id,
  session id, requesting tool, options and the client that started the turn.
- **Client identity.** Every attach sends a client id and its capabilities
  (`view`, `control`, `prompts`). A prompt routes to the initiating client, with
  the owner (desktop) as fallback; the first valid response resolves it and every
  other client receives `prompt.resolve` with `answeredBy`.
- **Control set.** A paired LAN/Tailscale device may send, interrupt, stop and
  answer prompts. Public clients (later) get view by default and control only by
  an explicit grant.
- **Native-only actions** (native dialog, notifications, tray, updater) belong to
  the desktop shell, not the host. The desktop WebView reaches them through a
  Tauri-side bridge; a remote browser has no such bridge and the UI reports them
  unavailable. The host never proxies tray/updater.
- **Status and updates are host state.** No client spawns a process to learn the
  Node version; the host owns the manifest and the update state.
- **Detach never stops a session.** Page reloads and window recreation only
  unsubscribe; generation-based stopping is removed.

Protocol additions: `client.hello`, `client.capabilities`, `prompt.open`,
`prompt.resolve`; commands `prompt.answer`, `session.interrupt`, `session.stop`.

## Capacity and bottleneck evaluation (2026-10-30)

Question: if one host manages the runtime pool, does the host become the
bottleneck?

Neutral answer: **not by default for a single-user desktop**, but the risk is
real and depends on four implementation choices, not on "one host" itself.

### Where the work actually is

- Each session is a separate Node process. Model calls are network-bound; tool
  CPU (image conversion, git, builds) runs in the child, not in the host.
- The host does: process lifecycle, stdout/stderr parsing, event fan-out, SSE
  encoding, buffers/replay, prompt routing, client queues. That is orchestration
  and serialization, not the heavy work.
- Desktop scale: the UI pool targets ~5 warm sessions and 30 as capacity; at most
  a few turns stream at once. Peak host event rate is roughly the sum of token
  deltas and tool events (order of 1–5k events/s in a burst), not per-session
  independent streams.

### Four real risks

| Risk | Why it bites | Mitigation |
| --- | --- | --- |
| Single-threaded event loop (if the host is Node) | JSON parse/stringify and SSE fan-out serialize; a large tool payload stalls every session | Rust/tokio host, or worker threads; coalesce deltas before fan-out |
| Unbounded buffers / large payloads | replay buffers, base64 images, tool output; 30 × 2 MiB is 60 MiB before projections | caps per session, spill large payloads to disk, reference by id |
| Slow client | a phone on a bad network backpressures the fan-out | per-client bounded queue, coalescing, disconnect + snapshot resync |
| Crash blast radius | one host crash kills every session, vs per-session supervisors | session JSONL persistence, restart, optional sharding by workspace |

A single host is therefore a **multiplexer**, not a compute bottleneck. The
failure mode to design against is memory and head-of-line blocking, not raw
throughput.

### When sharding is actually needed

- 100+ concurrently streaming sessions on one machine, or
- a multi-user server (not the desktop model), or
- heavy fan-out to many remote viewers of the same session.

The design keeps a routing key (session id → host instance) so a later shard is
possible without changing the client. Sharding is **not** part of v1.

### Verification (before claiming capacity)

Load test with the host alone, no model calls: synthetic sessions emitting token
deltas and tool events at burst rates; measure:

- p50/p99 event delivery latency per client;
- host CPU and RSS at 5, 30, 100 sessions;
- memory per session with replay enabled;
- slow-client behavior (throttled connection) and snapshot recovery;
- host restart with persisted sessions.

Acceptance for v1: 30 sessions / 2 active streams / 2 clients stay under a
defined CPU and memory budget with no event loss; the numbers are recorded before
any "it scales" claim.

## Boundaries: host, desktop shell, remote (2026-10-30)

The decided architecture stays: **the host serves the UI; the desktop WebView
loads the host origin**. There is one UI build and one API path. Reopening this as
"UI stays in Tauri" was wrong and is rejected.

The boundary follows the DSH Tauri project:

- **Host**: serves the SPA, `/v1` HTTP + SSE, sessions, prompts and history. It
  knows nothing about trays, installers or window lifecycle.
- **Desktop shell (Tauri)**: owns the window, tray, updater, autostart, native
  notifications and the desktop auth/bridge adapter. It loads the host-served UI.
  DSH's `dsh-tauri` plugin exists for exactly this: its description says the
  embedded sandbox WebView is cross-origin and cannot complete a
  `SameSite=Strict` cookie exchange, so the shell provides the message bridge and
  auth adapter.
- **Remote**: a browser or mobile WebView loads the same host-served UI over HTTP.
  It has no Tauri bridge; tray, updater and native notifications do not exist
  there. DSH's `dsh-tauri-remote` is SSH host management plus sharing the local
  Harness over LAN/public tunnels, not a tray feature.
- `GET /v1/capabilities` reports host/API features. Desktop bridge availability is
  detected separately by the shell bridge handshake; there is no
  `/v1/platform/{action}` proxy for shell-only actions.
- The UI hides or disables desktop-only actions with an explicit unavailable
  state when the bridge is absent. It never pretends.

Phase 3 therefore is: host serves the SPA; the desktop shell loads it and exposes
only its bridge for native-only actions; the UI moves to `/v1` + SSE. No
Tauri-internal UI variant and no host proxy for tray/updater.
