# 0010 — Phase C consolidates control, catalog, session and chat in the host

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Partly superseded, partly implemented.
- D12 (new sessions deferred) is replaced by [0016](0016-new-session-ready-at-once.md);
  D14/D20 (model list from the control adapter) by [0015](0015-runtime-facts-relayed-not-reinterpreted.md).
- Implemented: D13 normalized history, D15 serialized control, D16 bounded pending handles,
  D17 `SessionStore`.
- D18 in part: the raw command proxy is gone; `runtime.event` is still published on the
  event stream.
- D19 was a one-time checkpoint.
Date: 2026-11-03
Updated: 2026-11-12 — the branch now has a chat path through raw runtime commands;
current state in `tasks/0096-phase-c-cp0-audit.md`
Related: ADR 0007, ADR 0008, ADR 0009, `spec/03-host.md`,
`tasks/0086-phase-c.md`, `contracts/host-ui-v1.md`, `contracts/jouzu-api-v1.md`

## Context

Phase C moves the 1.0.23 chat behavior from the UI/Tauri shell to the host. The
existing documents describe the destination in fragments: ADR 0007 owns the host
transport, ADR 0009 owns the UI API, `host-ui-v1.md` owns the wire shapes, and the
Phase C task names control/catalog/session/chat checkpoints. They do not agree on
the event envelope, the catalog source, the new-session lifecycle or the history
model. At the time of writing the construction branch had no working chat: the UI
gated chat on a feature no adapter advertised. As of 2026-11-12 it has a chat path
through raw runtime commands, which is not the destination described here; see
`tasks/0096-phase-c-cp0-audit.md`.

The result is not executable: each checkpoint can satisfy one document and
contradict another. The product spec resolves the product and module boundaries;
this ADR records the decisions that constrain more than one checkpoint.

## Decision

1. **New sessions are always deferred (D12).** `POST /v1/sessions` without a
   `sessionPath` creates a pending host handle with no runtime and no JSONL. The
   first user message starts the runtime and admits the message atomically.
   `deferred:false` is rejected. A new chat never persists an empty session.
2. **One SSE frame and one normalized history model (D13).** Events use
   `id: <seq>`, `event: <type>`, `data: {seq, sessionId, …}`. History is a
   normalized block model owned by the host (text, thinking, toolCall, toolResult,
   attachment, custom). The UI never sees raw runtime records.
3. **Jouzu owns model enumeration (D14).** The host obtains the usable model
   snapshot from the private control adapter's `available-models` action. The host
   does not parse `cache/model-catalog/**`, does not merge accounts, and does not
   reimplement availability. The host caches the snapshot and keeps the previous
   one on refresh failure.
4. **Control is one serialized host operation (D15).** `POST /v1/control` executes
   the embedded `control.mjs` through the managed Node and active app, under the
   shared update lock, in a Job Object, with SSE progress (`control.device`) and a
   cancel endpoint.
5. **Pending handles are memory-only and bounded (D16).** They are dropped on
   stop, failed first message, host restart or TTL. There is no file and no
   orphan-cleanup task.
6. **The UI uses a SessionStore, not a runtime owner (D17).** `SessionStore`
   subscribes to one SSE stream, applies normalized events idempotently, loads
   history pages and sends intents through `JouzuApi`. `ChatConnection`,
   `ChatPool`, `HostChatTransport` and `TauriChatTransport` are removed.
7. **`runtime.event` and the raw command proxy are removed (D18).** The UI
   contract has no raw runtime event or `/sessions/{id}/command`; host endpoints are
   typed.
8. **C-0 is headless for chat (D19).** At decision time the branch had no working
   chat; the 1.0.23 build is the chat baseline. CP1–CP4 are proven through the host
   API and one real runtime prompt. CP6 is the first checkpoint that claims product
   UI chat.
9. **The model snapshot survives failure (D20).** A valid snapshot is returned
   without network or a session; a failed refresh keeps the previous snapshot and
   offers Retry. This covers the 1.0.23 catalog-retry requirement.

The normative host spec is `docs/spec/03-host.md`; the product and module specs are
in `docs/spec/`. The wire shapes are `docs/contracts/host-ui-v1.md`; the UI
interface is `docs/contracts/jouzu-api-v1.md`.

## Consequences

Positive:

- One owner per concern; one UI and one API; remote is the same client.
- Reloads and window recreation do not stop work.
- The UI cannot read JSONL, raw runtime events or the managed root.
- Catalog parity follows Jouzu's own projection instead of a host reimplementation.
- Empty sessions are prevented structurally, not filtered after the fact.
- The Phase C checkpoints are traceable to one product spec and one decision
  record.

Negative:

- The host must own a serialized control pipeline, a model snapshot cache, a
  pending-session state machine and a normalized projection. That is real
  complexity, not a thin proxy.
- The control adapter grows one read-only enumeration action.
- The UI migration is larger than swapping a transport: the chat state layer is
  replaced.
- C-0 does not exercise chat in the product UI; the 1.0.23 build remains the visual
  baseline until CP6.

## Alternatives rejected

- **Host parses the active catalog document.** It cannot represent configured
  non-catalog providers or availability without reimplementing Jouzu's schema, and
  the active-account selection is Jouzu-owned.
- **Keep `runtime.event` as the UI transport.** It exposes raw runtime internals,
  contradicts the anti-pattern gate, and makes the UI depend on the runtime file
  format.
- **Eager new-session runtime.** It starts a process on a blank chat, creates the
  empty-session risk and wastes work when the user never sends.
- **Re-enable the Tauri chat path for C-0.** It adds the forbidden dual path and
  hides the real migration state.
- **A second UI or preview page.** It forks rendering and violates ADR 0007/0009.
- **A provider plugin/probe or static fallback.** A provider is configuration.

## Migration

CP0 aligns the product spec, contracts and task. CP1 adds host control; CP2 adds the
model snapshot; CP3 adds the pending session lifecycle; CP4 adds normalized chat;
CP5 proves the host headlessly; CP6 switches the UI; CP7 runs parity and remote
smoke. Each checkpoint's gate is in `tasks/0086-phase-c.md`.

## Open questions

- Can Jouzu expose the same available-model projection through the control adapter
  without a session? CP2 must prove it; if not, stop and extend the adapter, do not
  move the projection into the host.
- Host/desktop version stamping for packaging.
- macOS/Linux job object and lock enforcement (Windows is the Phase C platform).
