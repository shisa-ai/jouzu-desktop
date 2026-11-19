# Session switching task and acceptance matrix

This is the canonical task and acceptance document for session opening, switching,
history loading, and the session-scoped TextGuard bar.

## Product invariants

1. A session row click changes the visible session on the next frame. It does not attach
   the runtime.
2. The visible transcript comes from the newest local messages first. It is not replaced
   by an empty intermediate projection.
3. The runtime attaches only when an action needs it: send, Review, or an explicit
   extension command.
4. One user action produces at most one runtime attachment.
5. A session that never had a TextGuard event never shows the TextGuard bar.
6. TextGuard is scoped to the currently attached session. A previewed or historical session
   never shows a bar. Only a live inspect payload may be actionable; transcript text is not
   review data.
7. TextGuard reviews are not persisted. Switching away removes the bar; a runtime restart
   discards pending review content. The UI must not promise recovery.
8. Opening a session positions the transcript at its newest turn.

## State model

- `selectedSession`: what the user is viewing. Owned by `ChatWorkspace`.
- `attachedSession`: what the runtime currently owns. Owned by `ChatConnection`.
- `TextGuard`: in-memory state for the attached session only.

No other component may own or reset those states.

## Test matrix

### A. Session shapes

| Case | Fixture | Expected |
| --- | --- | --- |
| empty | no messages | empty state, no article |
| short | 2 messages | newest answer visible |
| long | 60 turns | last 30 rendered, scroll at bottom |
| very long | 400 turns | bounded read, no blank, scroll at bottom |
| tool heavy | many tool calls | tools render, no duplicate transcript |
| image turn | image block | image renders, scroll stays at bottom |
| failed turn | errorMessage | error visible, transcript intact |
| recovered | recovered suffix | opens like its source session |
| TextGuard history in preview | no bar; no runtime attach |
| live TextGuard inspect with items | yellow bar with item content |
| live TextGuard inspect with zero items | green bar, modes available |
| switch away from a TextGuard session | bar hidden; no recovery promise |
| clean | no bar |

### B. Switching sequences

| Case | Action | Expected |
| --- | --- | --- |
| single | A | zero `switch_session` calls while opening |
| pair | A then B | zero calls while opening; B transcript visible |
| rapid | A, B, C, D within 300ms | final D visible, no blank intermediate |
| repeat | A/B/A/B × 10 | no duplicate loads, final B visible |
| same row | A twice | one visual selection, no second load |
| during startup | click A before first connect | no blank, one final load |
| refresh | open A, refresh, click A | no double load, no blank |
| send | open A, send | exactly one `switch_session`, then one prompt |
| send during attach | send before attach completes | one switch, prompt after it |

### C. TextGuard

| Case | Expected |
| --- | --- |
| live inspect with items | yellow bar, item content |
| live inspect with zero items | green bar, no item |
| previewed historical event | no bar, no runtime attach |
| switch away | bar hidden |
| approve | item removed |
| dismiss | item removed |
| mode change | On/Strict/Off inside Review panel |
| clean session | no bar |

### D. Performance metrics

Measured in Playwright with `performance.now()` around the click and the first rendered
message. Driver overhead is excluded from the in-page metric.

| Metric | Target |
| --- | --- |
| click to selected title/row | <= 16ms |
| click to first cached message | <= 50ms |
| click to first disk message | <= 250ms |
| runtime attach on open | 0 |
| runtime attach on send | 1 |
| blank transcript frames during switch | 0 |
| duplicate switch calls for one intent | 0 |

## New task

Implement the matrix in this order:

1. Add a fixture builder that creates deterministic sessions for every shape.
2. Add `session-matrix.spec.ts` with data-driven shape and sequence tests.
3. Instrument click-to-selection and click-to-first-message with `performance.now()`.
4. Add a TextGuard scope test proving a previewed historical event shows no bar.
5. Keep the old `session-switch.spec.ts` only for the send-time switch path.
6. Record failures as a regression table in this document before fixing them.

## Last sampled metrics

Controlled Playwright fixture, 6 samples per shape and 10 alternating switches. Values are
in-page `performance.now()` milliseconds; driver overhead is excluded.

| Case | Samples | Selection | Content median | Content p95 | Settled | Blank frames | Stale frames | Scroll gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| short | 6 | 0 | 28.2 | 28.5 | 111.4 | 0 | 2 | 0 |
| textguard | 6 | 0 | 28.6 | 28.7 | 112.0 | 0 | 2 | 0 |
| long-160 | 6 | 0 | 28.8 | 28.9 | 112.2 | 0 | 2 | 0 |
| empty | 6 | 0 | 11.8 | 12.3 | 95.1 | 0 | 1 | 0 |
| alternating | 10 | 0 | 28.6 | 28.8 | 111.8 | 0 | 2 | 0 |

`switchCalls` for all samples: 0. `Settled` includes an 80ms quiet-window guard.
Raw output: `test-results/session-metrics.json`.

These are fixture numbers; real disk and real runtime attach must be sampled separately.

## Real app sample

Run against the running desktop app and real session files, not the fixture. A unique spacer
session was opened before each measured row so the header always had to change. Timestamps
are measured in the page; condition waits use 5ms polling.

| Case | Samples | Selection median | Content median | Settled median | Articles | Scroll gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| short `hi` | 6 | 79.2ms | 81.7ms | 187.2ms | 2 | 0 |
| short `hello` | 6 | 77.4ms | 80.4ms | 185.8ms | 2 | 0 |
| TextGuard skill | 6 | 84.9ms | 86.9ms | 199.4ms | 9 | 0 |
| long heavy (3.92MB) | 6 | 53.2ms | 356.3ms | 466.5ms | 30 | 0 |
| alternating ×10 | 10 | 78.7ms | 81.1ms | 187.6ms | 2 | 0 |

`settled` includes a 100ms quiet window after content. Raw output:
`test-results/session-metrics-real.json`.

The fixture numbers above describe the UI harness, not the product. The real app opens a short
session around 80ms, and a 3.92MB session needs about 356ms to first content. There is no 1ms
content claim.

## Regression log

| Regression | Status | Guard |
| --- | --- | --- |
| Two runtime loads after one click | fixed | `matrix: rapid and repeated switching` |
| Empty projection replaced a visible preview | fixed | `matrix: long transcripts open at the newest turn` |
| Opening showed Working / Sending | fixed | `matrix: every session shape` |
| Session opened above the newest turn | fixed | bottom-gap assertion |
| Synthetic TextGuard Review turned green with no content | fixed | `matrix: TextGuard history is hidden while the session is only previewed` |
| Review and Options swapped based on data | fixed | one Review entry, modes inside |
| Refresh created a second load | fixed | `matrix: refresh during a session view` |

## Current run

```text
npm test                                        13 files, 81 tests passed
npm run test:session                            8 tests passed
```

`test:session` runs the session matrix, the send-time switch test, and the sampled metrics
harness.

## Current known debt

- Preview reads are capped at 4MB / 200 messages. A single giant tool result can therefore
  produce fewer than 30 visible turns; the UI must not expand the read to compensate.
- The runtime still reads full history during attach. Opening a session no longer waits
  for it, but attach latency remains unbounded.
- TextGuard reviews are memory-only. They disappear on switch or runtime restart by design.
- Existing e2e fixtures use two tiny sessions; they do not cover long histories, rapid
  switching, refresh, or TextGuard.
