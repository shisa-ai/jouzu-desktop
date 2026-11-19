# 0009 — UI depends on one platform API; implementations are siblings

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted; amended by [0021](0021-web-and-remote-are-one-client.md) (web and remote are one client)
Date: 2026-10-30
Related: 0007, 0008, 0010, `spec/03-host.md`,
`contracts/jouzu-api-v1.md`

## Context

The product UI currently calls `@tauri-apps/api` directly (`invoke`, `listen`,
`getCurrentWindow`, `isTauri`). That makes Tauri the UI's interface and forces
platform branches into components. The host architecture makes the same UI run
against the host origin (desktop and web/remote), so a Tauri-shaped interface is
wrong.

An earlier draft split the abstraction into `HostApi` and `ShellApi` and composed
them into a third interface. That creates two parents and moves the platform
choice back into the UI.

## Decision

### One abstract parent

`JouzuApi` is the only interface the UI depends on. It exposes the operations and
events the product needs, grouped by concern:

- `sessions` — list/attach/history/send/interrupt/stop/update/branch/recover/timing;
- `prompts` — approvals and questions;
- `runtime` — status, update state, components;
- `workspaces` — recent/add/forget;
- `models` and `commands` — model/thinking, fork/compact/export/reload, flow commands;
- `artifacts` and `files` — list/read/delete/counts, workspace listing;
- `settings` — environment, control/account, image tools, diagnostics;
- `native` — file picker, reveal, open external, terminal, updater/tray actions;
- `events` — session event subscription;
- `capabilities` — what this platform can do.

Components receive/call `JouzuApi` only. They do not import `@tauri-apps/api`, do
not check `isTauri()`, and do not know whether the implementation is desktop or
web.

### Sibling implementations

Platform implementations are siblings, not wrappers around each other:

```ts
abstract class JouzuApi { ... }

class DesktopApi extends JouzuApi { ... } // host HTTP/SSE + shell bridge
class WebApi extends JouzuApi { ... }     // host HTTP/SSE; native unavailable
class RemoteApi extends JouzuApi { ... }  // host HTTP/SSE with remote scope
```

`JouzuHost` is the host process/service, not a UI type. It never appears in this
inheritance tree.

### Capability, not platform, in the UI

`native` methods exist on the parent. `WebApi`/`RemoteApi` return a typed
`capability-unavailable`; `DesktopApi` forwards to the shell bridge. The UI reads
`capabilities`/the error and hides or disables the action. There is no
`if (isTauri)` in a component.

### Selection

Exactly one place creates the implementation:

```ts
const api: JouzuApi = createJouzuApi();
```

Desktop host UI: `DesktopApi` (host transport + shell bridge).
Web/remote: `WebApi`/`RemoteApi` (host transport; native unavailable).
The old Tauri window is removed; there is no compatibility adapter in the product.

### Contract ownership

`contracts/jouzu-api-v1.md` is the UI-facing interface; `host-ui-v1.md` remains
the host wire contract. Host methods in the API map to `/v1` endpoints; native
methods map to the shell bridge and are never host endpoints. The API contract
does not duplicate wire shapes; it references the host contract.

## Consequences

- The UI is one codebase with no platform branches in components.
- The host contract is derived from the API's host groups, not from an `invoke`
  inventory.
- Native capabilities are explicit and testable; remote never pretends.
- The UI call sites must be migrated from `invoke` to `JouzuApi` once; markup and
  behavior do not change.
- Until the migration is complete, the host UI cannot be wired to SSE; the
  existing Tauri UI remains the only working product path.

## Rejected

- **Compose `HostApi + ShellApi` into `JouzuApi`**: two parents; platform choice
  leaks back into the UI.
- **Keep `invoke` and add host endpoints per command**: Tauri becomes the
  interface; web/remote cannot satisfy it without a shim.
- **UI-level `isTauri()` branches**: every component becomes platform-aware.
