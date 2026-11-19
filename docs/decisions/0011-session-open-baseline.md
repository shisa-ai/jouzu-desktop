# 0011 — Session open baseline: 2570a2d

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Superseded by the host session model in [`../design/host-layer.md`](../design/host-layer.md)
- Date: 2026-11-09
- Supersedes: the session-open patch chain that started with `aaa3a70`

## Context

Opening a saved session grew into a chain of desktop-side patches:

```text
aaa3a70  perf(chat): acknowledge session switches immediately   (local preview)
74a8c5a  fix(chat): make the preview match the rendered transcript
bc77577  fix(chat): open a session without attaching the runtime
2570a2d  perf(chat): cap preview reads at four megabytes
51bbe51  fix(chat): load a recent page for large sessions
bebd847  fix(transcript): page earlier messages on demand         (256 MB scan)
```

Each patch added a second source of truth: a local transcript next to the runtime's
authoritative history, a local page size next to the runtime's transcript, a local
session repair next to the session file. The result was a session that could sit on
`Starting session…`, go offline when a frame exceeded the transport limit, or spend
seconds re-reading its own file.

Phase C moves runtime, session, history and transport ownership to the host, so every
one of these patches is removed there rather than repaired here.

## Decision

1. The baseline for **opening a session, its preview and its history read** is
   `2570a2d`. The behavior is: a 4 MB tail read once for the preview, and an
   authoritative `get_messages` for the transcript.
2. That chain is frozen. No further desktop-side patch is accepted in it; the
   replacement happens in Phase C (see ADR 0010).
3. A transcript above the transport frame limit is a per-session failure, not an
   offline session: the connection stays, `historyError` is reported with a Retry.
4. Unrelated bugs are fixed normally, one commit and one test each.
5. Published versions are never withdrawn; fixes ship in later versions.

## Consequences

- Sessions larger than 20 MB show only the tail again and have no earlier-history
  entry until Phase C provides paging from the host.
- A session whose transcript exceeds the frame limit cannot be opened in this build;
  it now says so and offers Retry instead of failing silently.
- Desktop-side session repair (invalid images) is not reintroduced.
- Exit-code and stderr diagnostics from `chat.rs` are not reintroduced.

## References

- `docs/tasks/0086-phase-c.md`
- `docs/adr/0010-phase-c-host-consolidation.md`
