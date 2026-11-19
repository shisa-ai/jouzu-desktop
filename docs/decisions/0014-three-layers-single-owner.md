# 0014 — Three layers, one owner per piece of state

Status: Accepted
Date: 2026-11-17

## Context

Cascading bugs (models, busy state, errors) came from the same state being kept in
several places and bridged: the UI held four copies of the model list, the host and
UI each inferred run state, and fixes bridged the copies instead of removing them.
Later work stitched the layers back together by importing runtime internals into the
host and rewriting design docs and test gates in the same commits as code.

## Decision

- The desktop has three layers: **runtime** (jouzu), **host** and **UI**. Each is
  described in [`../design/`](../design/) and talks only through the contract of the
  layer below it.
- Every piece of state has exactly one owner. The host owns session state,
  configuration operations and errors; the runtime owns models and agent behaviour;
  the UI owns only what the person is doing on screen.
- The host never trusts its caller: it checks every precondition and refuses with a
  typed code. It does not wait or fall back on the caller's behalf.
- The UI works by subtraction: a path that must fail is disabled or hidden with its
  reason in place.
- A fix removes a duplicate source of truth; it never bridges two.
- A review checks layer boundaries first, then the patch.
- Design docs and acceptance gates are never changed in the same commit as the code
  they judge.

## Does not mean

- Layer purity is never paid for with user experience. If a correct boundary makes
  the product slower or harder to use, the design is wrong, not the person.
- Caching data another layer provides is allowed, as long as the cache has one owner
  and is refreshed when its source changes.
