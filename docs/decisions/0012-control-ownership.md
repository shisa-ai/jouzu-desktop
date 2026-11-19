# 0012 — Control ownership: the host executes Jouzu configuration

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Partly implemented, partly superseded.
- Implemented: D1–D4 (host `/v1/control`, job ownership, cancel and timeout), D8 (embedded
  `control.mjs` with `--eval`). Operations are now queued instead of refused ([`../design/host-layer.md`](../design/host-layer.md) §5).
- D5 (models from `status.models`) is superseded by
  [0015](0015-runtime-facts-relayed-not-reinterpreted.md).
- D6 in part: the UI no longer calls the shell for configuration, but the shell still
  registers the unused `model_catalog` and `image_models` commands.
- D7 (development uses the production chain) has not been re-checked.
- Date: 2026-11-10
- Related: `docs/tasks/0086-phase-c.md` CP1, `docs/spec/03-host.md` §5, `docs/contracts/host-ui-v1.md` §4

## Context

The shell used to run `packaging/desktop/control.mjs` itself and stream device codes to
the UI over a Tauri event. Phase C moves control to the host, so the shell must not
execute the adapter and the UI must not call a Tauri control command.

## Decisions

### D1 — The execution model is a port of the shell's implementation

The shell's version already covered serialization, the shared update lock, concurrent
pipe reads, stderr device lines, cancellation, the 190 second deadline, the hidden
console and sanitized errors. The host port keeps that behavior and adds the job object
and the event stream.

### D2 — Events and cancel follow the contract

`control.started`, `control.device`, `control.finished`, `control.error`; `requestId`
threads through all of them; a concurrent request is `409 control-busy`; a 100 event
replay follows `Last-Event-ID`.

### D3 — Cancel and timeout terminate the job

The adapter has no cancel channel, so cancelling or timing out terminates the whole job
tree. An idle cancel is a successful no-op.

### D4 — Job ownership

The host owns the job of the control child (`KILL_ON_JOB_CLOSE`); the shell owns only
the host. Closing the window does not stop either.

### D5 — The model list is `status.models`, and thinking levels come from the runtime

`status` already returns `models[]` built from Jouzu's own projection
(`runtime.getModels()`), with `provider`, `id` and `name`. The host does not parse
`cache/model-catalog/**` and does not add an `available-models` action. Thinking levels
come from the runtime RPC `get_available_thinking_levels`; a pending session shows none
until it attaches. If a future UI need requires more fields, `status` gains them
additively.

### D6 — Switch order

Host endpoints first, then the UI, then removal of the Tauri commands, all inside CP1.
Both paths must never be reachable at the same time.

### D7 — Development uses the production chain

`tauri dev` also spawns the host and loads its origin; assets are served from
`apps/desktop/dist` (`vite build --watch`). There is one contract in every
environment; only the asset source is a build artefact. An HMR proxy, if wanted, is a
CP6 concern.

### D8 — Adapter shape

CP1 embeds the script and passes it with `node --eval`. The script is 16,805 bytes and
the Windows command line is capped at 32,767 characters, so `MAX_SCRIPT_BYTES = 24 KiB`
fails loudly before spawn rather than at process creation.

Three shapes were considered:

| Shape | Trade-off |
| --- | --- |
| A embedded `--eval` (chosen) | No file on disk, version-locked to the binary; poor stack traces |
| B shipped `control.mjs` file | Debuggable; drifts from the binary version and needs a writable/readable app dir |
| C a Jouzu-provided config command | Cleanest boundary; requires work in the Jouzu repository |

B is rejected because version drift is the failure mode the desktop must not have. C is
recorded as the long-term shape.

## Responsibility boundary

| Concern | Owner | When unsupported |
| --- | --- | --- |
| Spawn, job, concurrent reads, timeout, cancel, serialization, update lock, events, routes, error sanitizing | Host | Implemented here |
| Config semantics, `agent/`, `state/`, catalog decisions, device flow | Jouzu | Not reimplemented |
| Model projection fields | Jouzu | Additive `status` fields only |
| Structured event channel instead of stderr lines | Jouzu | Draft only (below) |
| Graceful cancel inside the adapter | Jouzu | Draft only (below) |
| No-empty-file guarantee | Jouzu (`04-runtime.md` §6) | No host cleanup patch |

## Integration acceptance

Shisa.AI sign-in and provider OAuth already work in 1.0.23. CP1 does not re-prove them; it
proves the host carries them unchanged. Separating the two matters: the adapter is a known-
working subsystem, the host plumbing is what is new.

Carried by construction (no re-testing of the subsystem):

- **Device code forwarding.** `control.mjs:76` writes the device line to stderr; the host's
  stderr reader parses it and publishes `control.device`; `/v1/control/events` replays and
  streams it; the UI subscribes to that event name. Four links, each present in code.
- **Cancel covers everything the adapter starts.** `control.rs:279` assigns the job before
  `control.rs:283` hands the adapter its request, and `control.mjs:14` blocks on stdin before
  doing any work. Nothing can be started outside the job.

Still open, and the only blocking item:

- **No product-level evidence that Settings works through the host.** This branch's Playwright
  suite predates the host-served UI: the app boots `createJouzuApi()`, which reaches for
  `/v1/workspaces`, so the suite needs a real host to run. That is an environment the product
  provides, not a stub to build. Until it runs, CP1 has unit and integration coverage and no
  product-level proof.

Related risks for you to weigh, not decisions taken here:


- Device codes travel as JSON lines on stderr rather than a typed channel, so the host
  parses text.
- `in_flight` lives in memory: a host restart forgets it, and a cancel after restart is
  a no-op.
- Cancelling is a hard termination; the adapter cannot clean up a half-finished sign-in.

## Verification

Automated, on this branch:

```text
cargo test (apps/desktop/host)         50 unit tests, real parser and resolver
cargo test --test control              3 tests against the REAL adapter + real Node
  JOUZU_HOST_TEST_APP=<installed app>  required; without it the tests skip and say so
  JOUZU_HOST_TEST_HOME=<real home>     optional; real data instead of an empty temp home
vitest                                  145 tests, including the control client
tsc --noEmit                            clean
cargo check (src-tauri)                 clean after the Tauri control path was deleted
```

Real status output (this machine, real home): `schemaVersion: 1`, `models[]` populated
with Jouzu catalogue entries (`provider`/`id`/`name`), `providers[]` present.

The gaps listed under Unfinished acceptance work are the only things not covered; they are
recorded there once rather than duplicated here.

## Draft upstream requests (not filed)

These are drafts only. Nothing was filed; each needs review first.

1. **Structured control events.** Replace JSON-on-stderr with a typed channel so the host
   does not parse text. Evidence: the host currently reads lines and ignores anything
   that is not `{"type":"device"}`.
2. **Graceful cancel.** Give the adapter a cancel signal so a cancelled sign-in can clean
   up instead of being killed. Evidence: `provider-oauth` waits up to 180 s for a browser
   callback with no way to stop it other than termination.
3. **Model snapshot fields.** If the UI needs availability or thinking levels in the
   model list, `status.models` must carry them.

## Open questions

- Whether CP1 should also own the `/v1/models` endpoint or leave it to CP2. This ADR only
  settles where the model list comes from.



