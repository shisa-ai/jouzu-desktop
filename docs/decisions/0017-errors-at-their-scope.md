# 0017 — Errors are shown at their own scope

Status: Accepted
Date: 2026-11-16

## Context

Errors were collected into one notice list above the composer, so a failing tool,
a refused image and a lost runtime all looked alike, repeated, and pushed the layout
around.

## Decision

- Each error is shown where its scope lives: tool card, message row, reply row,
  control, settings card, start page. The slots are defined in
  [`../design/host-layer.md`](../design/host-layer.md) §6.
- An error changes only what it interrupted. Operations in different scopes never
  block or fail each other.
- A session-level error means only that the session was ended by an error. There is
  at most one, never a queue; it carries one recovery action.
- Errors are never silent, are shown once, are localized, and never move or resize
  the layout. No floating toasts.

## Does not mean

- The steer queue (messages sent during a run) is not an error queue and stays.
- Diagnostics belong in the host log, not on screen.
