# Decisions

One record per decision. A record is never rewritten: when a decision changes, a new
record is added and the old record's status points to it. Each newer record says what
it does **not** mean, so it is not applied more widely than intended.

Records 0001–0012 come from the former planning repository (migrated 2026-11-19).

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-desktop-repository.md) | Desktop is a separate product repository | Accepted; amended by 0013 |
| [0002](0002-independent-install.md) | Desktop installs independently from Launcher | Accepted |
| [0003](0003-no-bundled-runtime.md) | Desktop releases do not bundle a runtime | Accepted; runtime now provisioned from npm |
| [0004](0004-chat-view-concurrency.md) | The chat view keeps concurrent sessions | Superseded for runtime ownership by 0007/0010; concurrency floor stands (0016) |
| [0005](0005-chat-link-and-file-actions.md) | Chat links open through one validated native boundary | Accepted |
| [0006](0006-desktop-release-gates.md) | Desktop release gates are the desktop's own | Accepted; refined by 0019 |
| [0007](0007-runtime-host-sse.md) | The UI subscribes to an independent runtime host over SSE | Accepted; shapes in design/host-layer.md |
| [0008](0008-remote-access.md) | Remote access: LAN and Tailscale first, public deferred | Implemented (Web access); amended by 0021 |
| [0009](0009-ui-platform-api.md) | UI depends on one platform API; implementations are siblings | Accepted; amended by 0021 |
| [0010](0010-phase-c-host-consolidation.md) | Phase C consolidates control, catalog, session and chat in the host | Partly superseded by 0015, 0016; rest mostly implemented |
| [0011](0011-session-open-baseline.md) | Session open baseline: 2570a2d | Superseded by the host design |
| [0012](0012-control-ownership.md) | Control ownership: the host executes Jouzu configuration | Partly implemented; D5 superseded by 0015 |
| [0013](0013-docs-in-product-repo.md) | Decisions and design live in the product repository | Accepted |
| [0014](0014-three-layers-single-owner.md) | Three layers, one owner per piece of state | Accepted; remaining duplicates listed in design docs |
| [0015](0015-runtime-facts-relayed-not-reinterpreted.md) | Runtime facts are relayed, not reinterpreted | Accepted; met in 1.1.4 |
| [0016](0016-new-session-ready-at-once.md) | A new session is ready at once | Accepted; met in 1.1.4 |
| [0017](0017-errors-at-their-scope.md) | Errors are shown at their own scope | Implemented in 1.1.3-rc.3 |
| [0018](0018-one-data-home-never-copied.md) | One data home, never copied | Implemented in 1.1.3-rc.2 |
| [0019](0019-development-and-release-gates.md) | Development checks are fast; release checks judge the installed product | Accepted; stable release checks not yet automated |
| [0020](0020-release-channels.md) | QA and stable are channels of one app | Implemented |
| [0021](0021-web-and-remote-are-one-client.md) | Web and remote are one client | Accepted; not implemented |
| [0022](0022-independent-qa.md) | QA is independent of development | Accepted; not set up |
| [0023](0023-problems-fixed-at-the-root.md) | Problems are recorded, then fixed at the root | Accepted |
| [0024](0024-no-launcher.md) | Desktop has no launcher | Accepted |

## Adding a record

Copy the shape of a recent record: title, status, date, context, decision, does not
mean. Keep it short; link to [`../design/`](../design/) for details instead of
repeating them. Commit it on its own, not with the code it decides about.
