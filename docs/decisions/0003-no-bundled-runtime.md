# ADR 0003 — Desktop releases do not bundle a runtime

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted  
Date: 2026-10-23

## Context

0007 planned a full installer that carried the Jouzu runtime payload, plus a
separate launcher-only update package. 0036 and 0037 built that model locally:
the 1.0.1 installer was 181,178,432 bytes and carried Node 24.22.1 and the
0.2.1 application payload.

The runtime has its own release train and its own version (core 0.2.1 beside
desktop 1.0.1). ADR 0001 keeps runtime source and runtime release machinery out
of this repository, and ADR 0002 gives the Desktop root its own runtime instead
of a shared one.

## Decision

- A Desktop release carries only the desktop shell: the Tauri binary, the
  frontend bundle, `console.exe`, the uninstaller and the updater metadata.
- It carries no Node, pnpm, PortableGit, Windows Terminal or Jouzu application
  payload.
- The desktop version is the release version. The runtime version is a separate
  value and is never used to name a desktop artifact.
- Runtime provisioning remains a Desktop capability, as in ADR 0002, but it is
  not part of the release artifact and is tracked separately.
- Because the package carries only the shell (3.57 MiB at 1.0.1), Windows needs
  one file for both first install and update. macOS keeps one installer for
  users (the dmg) and the updater consumes the `.app.tar.gz` of the same
  bundle. There is no full/update package pair.

## Consequences

- Installers and updates are a few megabytes instead of ~180 MB.
- A machine with no Desktop-managed runtime depends on provisioning before chat
  can start. Until that capability lands, a freshly installed release cannot
  start a workspace; that is a known gap, not a release defect to hide.
- Packaging that assumes a payload (`prepare-windows-bundle.ps1`,
  `finalize-windows-bundle.ps1`, `publish-launcher.ps1`,
  `prepare-published-runtime.mjs`) is not used by release CI. Retiring it is a
  separate task.
- The runtime update channel (`jouzu_update`, the signed recipe feed) stays
  unconfigured while no runtime is bundled.
