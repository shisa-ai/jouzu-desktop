# 0020 — QA and stable are channels of one app

Status: Implemented ([`../../packaging/launcher/RELEASE-CHANNELS.md`](../../packaging/launcher/RELEASE-CHANNELS.md)).
Date: 2026-11-13

## Context

A separate side-by-side test install could not test what users actually run (their
data, sign-ins and upgrade path). A previous release shipped a downgrade to the stable
feed.

## Decision

- QA is an opt-in update channel of the same app: same install directory, same data,
  same sign-ins. QA versions are named `X.Y.Z-rc.N`.
- Every stable release first ships on QA from the same commit and is upgrade-tested
  there; promotion to stable does not rebuild.
- The release workflow refuses downgrades. Switching back from QA to stable is an
  explicit, allowed downgrade.
- QA builds make no irreversible data-format changes.
- `develop` is the working branch; pull requests merge into `develop`. `main` holds
  only released code. QA builds are made from `develop`.
- Implementation: [`../../packaging/launcher/RELEASE-CHANNELS.md`](../../packaging/launcher/RELEASE-CHANNELS.md).

## Does not mean

- No per-fix test releases: fixes are batched into one QA release and verified there.
- Published versions are never withdrawn; fixes ship in later versions.
