# ADR 0002 — Desktop installs independently from Launcher

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted  
Date: 2026-10-22

## Context

Launcher and Desktop are sibling products. Sharing a runtime or install root
would require shared ownership, migration, refcounted uninstall, coordinated
updates and version compatibility between two independent products. That
complexity is not justified for the current release.

## Decision

- Launcher and Desktop are peer products.
- Launcher keeps its existing logic and install root:
  `%LOCALAPPDATA%\Shisa.ai\Jouzu`.
- Desktop uses a separate install root:
  `%LOCALAPPDATA%\Shisa.ai\JouzuDesktop`.
- The Desktop root has no spaces. Display name may remain `Jouzu Desktop`;
  paths, binary and directory names do not contain spaces.
- Desktop explicitly sets `INSTDIR` in its installer. It must not derive the
  install directory from `productName`.
- Desktop owns its own runtime, data, updates, uninstaller and updater feed
  under `JouzuDesktop`.
- Desktop does not detect, adopt, migrate or share a Launcher runtime.
- Launcher does not detect or manage Desktop.
- If no Desktop-managed runtime exists, Desktop installs its own managed runtime
  using the same class of installer behavior as Launcher, but in its own root.
- Existing npm installations are independent and are not adopted into Desktop.
- Each platform gets one Desktop installer. There is no full/update package
  pair.

## Consequences

- Both products can be installed at the same time without touching each other.
- Runtime is duplicated on disk when both products are installed. This is an
  accepted tradeoff for isolation and predictable uninstall/update behavior.
- No shared-runtime ownership, refcount or cross-product migration code is
  required.
- Launcher changes are out of scope.
- The Desktop installer needs an explicit custom install path instead of the
  default Tauri product-name path.
