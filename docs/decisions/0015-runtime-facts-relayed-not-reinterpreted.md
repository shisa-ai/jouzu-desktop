# 0015 — Runtime facts are relayed, not reinterpreted

Status: Accepted
Date: 2026-11-17 (caching clarified 2026-11-18)

## Context

The host and UI had added their own filters (hiding models they guessed were not
chat models), picked defaults the runtime had not picked, parsed runtime text and
slash commands, and invented limits (a 32 KiB message cap the runtime does not have).
The model list also came from two sources (a control program and the live runtime),
so the list and `set_model` disagreed. Supersedes D14/D20 of
[0010](0010-phase-c-host-consolidation.md) and D5 of
[0012](0012-control-ownership.md).

## Decision

- What the runtime gives is what the desktop shows: models, defaults, availability,
  rows that need credits. The host and UI add no filters, no default-picking and no
  text parsing.
- The model list comes from one source: each session runtime's
  `get_available_models`, relayed by the host.
- Limits come from what the runtime actually enforces, never from a number the
  desktop picks.
- A capability or event the runtime lacks is recorded as a runtime gap
  ([`../design/runtime-layer.md`](../design/runtime-layer.md)) and raised with the
  runtime. The host and UI do not work around it, not even temporarily.
- Checks that belong to the runtime (for example message size against the model's
  context window) are not the desktop's job.

## Does not mean

- The host may cache runtime answers (for example the last model list) so a new
  session shows its model at once; the cache is refreshed when configuration changes
  and live sessions are reloaded.
- Before calling something a runtime gap, verify it in the runtime source. A gap
  that turns out to exist only in our assumptions is not a reason to wait.
- "Last used model" for a new session is a UI choice and is allowed.
