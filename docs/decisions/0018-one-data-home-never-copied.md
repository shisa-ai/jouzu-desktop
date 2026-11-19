# 0018 — One data home, never copied

Status: Accepted
Date: 2026-11-16

## Context

1.1.3-rc.1 switched the desktop's runtime home, so sessions created by earlier
versions disappeared from the list. Earlier versions had also copied an old home on
first run; the runtime's Flow journals store absolute paths, so copied sessions
failed with "Flow session metadata is missing or inconsistent".

## Decision

- The desktop's runtime home is `<managed root>\data`
  (`%LOCALAPPDATA%\Shisa.ai\JouzuDesktop\data` on Windows), the home every desktop
  version up to 1.1.2 used.
- The desktop never migrates, copies or moves a runtime home or its sessions.
- The runtime itself is installed from npm at a pinned, verified version.

## Does not mean

- Sharing sessions with a separately installed `jz` is a runtime-level question,
  not something the desktop solves by copying.
- Tests never run against a person's real data directory; they use an isolated home.
