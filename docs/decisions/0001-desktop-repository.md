# ADR 0001 — Desktop is a separate product repository

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note, the status line and the removal of private repository names. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted; amended by [0013](0013-docs-in-product-repo.md) (planning and decisions now live in the product repository)
Date: 2026-10-21

## Context

The existing fork contains the desktop UI, the launcher, runtime source and
runtime release machinery in one history. The desktop product needs independent
versioning, identity and release cadence.

## Decision

- Jouzu Desktop is a standalone repository, created without imported history.
- `main` is the release branch; `develop` is the working branch and default.
- The desktop repository contains desktop source, packaging and CI only.
- Runtime source, runtime release machinery and runtime build history are not
  imported.
- Planning, task tracking and ADRs live in a separate private planning
  repository.

## Amendment — 2026-10-23

The product repository is public. The update feed is a GitHub release there, and
the Tauri updater downloads it without credentials, so the feed and the update
assets have to be anonymously readable. Only the planning repository
stays private. The rest of this ADR is unchanged.

## Consequences

- Desktop releases do not require moving or rewriting the launcher repository.
- Desktop and launcher identities and feeds remain independent.
- The desktop build may consume a released runtime artifact, but the runtime
  source and release process remain outside this repository.
- Any shared code must be introduced deliberately, not by importing the old
  monorepo history.
