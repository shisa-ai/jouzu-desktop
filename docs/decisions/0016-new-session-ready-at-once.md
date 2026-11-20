# 0016 — A new session is ready at once

Status: Accepted. Met in 1.1.4 (#160): Send is usable at once and the model shows from what
the runtimes last reported. 1.1.3-rc.3 did not meet it (Send waited for the runtime).
Date: 2026-11-18 (warm pool 2026-11-14)

## Context

Runtime start takes seconds on Windows. 1.1.3-rc.3 made Send wait for the new
session's runtime to report its models, so the model button was blank for several
seconds and the first message could go to the wrong model. Replaces D12 of
[0010](0010-phase-c-host-consolidation.md) (runtime started on the first message).

## Decision

- The host keeps warm runtimes for recently used folders (least recently used
  first). A new session adopts a warm runtime's own blank session.
- From clicking **New session**, the model is shown and Send is usable at once
  (0 s), using the cached model list and the person's last choice.
- A message sent before the runtime is attached is held by the host and delivered
  in order with the right model. Two messages sent at startup are never merged.
- An unused new session leaves no row in the session list.
- The concurrency floor of [0004](0004-chat-view-concurrency.md) still holds: no
  session blocks another, and no path refuses a session because of a count.

## Does not mean

- The warm pool size is not a cap; more sessions start more runtimes.
- "0 s" is measured from the person's click, not from Send and not only the host's
  part (see [0019](0019-development-and-release-gates.md)).
