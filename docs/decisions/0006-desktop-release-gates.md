# ADR 0006 — Desktop release gates are the desktop's own

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted; the split between development and release checks is refined by [0019](0019-development-and-release-gates.md)
Date: 2026-10-28

## Context

Jouzu Desktop is a separate product from the Launcher (ADR 0001). It is a Tauri
shell plus the chat UI, and its installer is the product. Its release workflow
was written by carrying the Launcher's release model over:

- `launcher-notes.mjs` requires a `CHANGELOG.md` section for the version, because
  the *Launcher's* update item displayed the Jouzu changelog. The desktop's feed
  notes do not need that file.
- The version had to agree in `package.json`, `Cargo.toml` and `Cargo.lock` by
  hand. The installer and the binary do need one version, but maintaining three
  copies is a source of drift, not a gate.
- The updater public key and the fixed `desktop-update` endpoint were checked on
  every build, so a test build could not be produced without release
  configuration.
- `launcher-checks.yml` ran the build, unit tests and `cargo test`, but never the
  chat/session e2e suite, and no installer was ever installed.

The desktop's product is the UI and the session behavior; the gates should prove
that, and only the release should prove the feed and the update.

## Decision

Desktop gates are defined here. The Launcher's release rules do not apply unless
this ADR says so.

### Build gate — every run, including `publish: false`

1. Frontend typecheck and build.
2. Unit tests, including the packaging node tests.
3. **Chat/session acceptance tests** (`npm run test:acceptance`): concurrent
   sessions, background turns, drafts, images, dialog routing, and the human text
   for every runtime limit the UI can show.
4. Native tests (`cargo test --bins`).
5. The NSIS installer builds. Signing is not required for a test build.

### Release gate — `publish: true` only

6. One version, from `apps/desktop/package.json`; `Cargo.toml`/`Cargo.lock` are
   derived from it rather than hand-checked.
7. Notes come from the dispatch input. A `CHANGELOG.md` section is an optional
   fallback, not a requirement.
8. The updater public key and endpoint are configured; the artifact carries a
   valid updater signature the compiled key verifies.
9. The feed and the asset are anonymously readable.
10. The installer is installed on a clean machine, the app starts, and chat can
    begin — which requires either a bundled payload or working runtime
    provisioning.
11. An in-place update from the previous published version succeeds.

### Removed

- The mandatory `CHANGELOG.md` section for every build.
- The hand-maintained Cargo version as a build gate.
- The updater configuration check outside `publish`.
- Any use of the Launcher's payload packaging scripts for a desktop release
  (ADR 0003 already says the release carries no runtime).

## Consequences

- CI is longer: the acceptance suite roughly doubles the frontend job, and the
  browser has to be installed on the runner.
- A test build is unsigned and cannot update an installed client; it exists to be
  installed and exercised.
- Until runtime provisioning exists, a release cannot satisfy gate 10 with the
  shell-only package. That is a blocking gap, not a gate to lower.
- ADR 0003 (no bundled runtime) is unchanged: provisioning, not bundling, is the
  release path. A full package remains a test-only artifact.
