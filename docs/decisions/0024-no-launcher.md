# 0024 — Desktop has no launcher

Status: Accepted
Date: 2026-11-19

## Context

Desktop was forked from the Jouzu Launcher, a separate product
([0002](0002-independent-install.md)). Its code, packaging and interface kept calling
the app "the launcher", so readers saw a component that does not exist in Desktop's
three layers ([0014](0014-three-layers-single-owner.md)). The Tauri app is the
**shell** ([`../product.md`](../product.md)). Issue #168.

## Decision

- Users see "Jouzu Desktop", in every language and in the installer.
- Code, CI and docs use shell, desktop or app: `apps/desktop/`, `packaging/desktop/`,
  `desktop-checks.yml`.
- Packaging that only served the Launcher's full and launcher-only packages is removed.
- The shell writes its PowerShell helpers to `<install>/runtime/desktop-tools/` from the
  copies built into it, before each run.

## Kept on purpose

These names are already on users' disks; renaming them would move data or break
installs that update in place ([0018](0018-one-data-home-never-copied.md)):

- `data/launcher-environment.bin`: environment variables saved in Settings.
- `launcher-runtime.json` in the Jouzu agent folder, written by the runtime bootstrap.
- `JOUZU_LAUNCHER_BASH`: read by `app/bootstrap.mjs`, which is not rewritten once it
  exists.

## Does not mean

- Install folder, data home, app identifier, installer names and update feeds do not
  change; none of them named a launcher.
- No file is migrated, copied or deleted on users' machines. A `runtime/launcher-update/`
  folder left by an earlier version stays where it is, unused.
- Records 0001–0023 are not rewritten; only their paths to moved files are updated.
- The Jouzu Launcher product itself is not affected.
