# Jouzu Desktop

Jouzu Desktop is a desktop front end for [Jouzu](https://www.npmjs.com/package/jouzu), an AI
work agent. It gives Jouzu a chat workspace: folders as workspaces, sessions that keep running
when the window closes, approvals and questions answered in place, files a turn changed, model
and tool settings, and in-app updates.

The agent itself is the jouzu runtime, installed from npm. Sessions, settings and sign-ins
belong to Jouzu and stay in Jouzu's own home folder, the same one the `jz` command uses, so
Desktop and the terminal see the same sessions. Desktop never copies or migrates that data.

The interface is available in English, Japanese, and Simplified and Traditional Chinese.
Windows 10 and 11 (x64) are the released platforms; the same sources build on macOS and Linux
for development.

## How it fits together

```text
 UI (React, in the Tauri window or a browser)
   │  HTTP + one SSE event stream: the window on loopback with a per-run token;
   │  other browsers only through Web access, paired one by one
   ▼
 host (jouzu-host, Rust)          owns sessions, queues, approvals, restarts
   │  JSON-lines RPC over stdio, one process per session
   ▼
 jouzu runtime (Node.js)          the agent: models, tools, extensions
```

- **UI.** The chat interface. It holds no session state of its own: it renders what the host
  reports and sends user actions back. Closing or reloading the window never stops a reply; a
  window that reconnects catches up from the host's event sequence.
- **Host.** A standalone process the app starts beside its window. It owns every session and
  its runtime process, keeps a visible queue for messages sent while a reply is running, turns
  runtime prompts into approvals and questions, restarts a runtime that dies, and keeps a few
  runtimes warm for recently used folders so opening a session does not wait for one to start.
  Because the host is separate from the UI, the UI can be replaced without touching sessions.
  See [`apps/desktop/host/README.md`](apps/desktop/host/README.md).
- **Jouzu runtime.** The agent itself, installed on first run from the official `jouzu` npm
  package together with a pinned Node.js. The desktop installer carries the app only; the
  runtime updates separately. It runs with Jouzu's own home (see below), not a Desktop
  folder. The host talks to it through an adapter, so the runtime is replaceable.
- **Shell.** The Tauri app (`apps/desktop/src-tauri`) starts the host, opens the window,
  provisions the runtime and applies app updates. A release shell runs only the host built
  with it, so an install never mixes builds.

## Install and update channels

Download the installer from the [releases page](https://github.com/shisa-ai/jouzu-desktop/releases).
The app checks for updates itself.

There are two update channels for the same installation, chosen in **Settings → System**:

| Channel | What you get |
| --- | --- |
| Stable (default) | Releases that have already passed testing on QA. |
| QA | Every new build first, for testing. |

The channel is only which feed the app updates from: it uses the same install folder, the
same data and the same sign-ins, so switching does not reset anything. Switching back to
stable offers the current stable build, and nothing installs until you confirm.

What you install decides what you have: a QA package is a QA build whichever channel is
selected, and the channel setting never changes the app's icon or behaviour. No stable
release has been published under this process yet; the builds published so far are QA
builds.

QA packages are release candidates (`X.Y.Z-rc.N`) and carry the Jouzu icon with a **QA**
badge. A stable release `X.Y.Z` is built again from the QA-tested commit with the normal icon,
must pass the full user playbook with a real model, and is signed. Details are in
[`packaging/desktop/RELEASE-CHANNELS.md`](packaging/desktop/RELEASE-CHANNELS.md).

## Web access

Besides the desktop window, you can use the same UI from a browser. It is off until you turn it
on in **Settings → Web access**, where you choose:

| Setting | Who can connect |
| --- | --- |
| Off (default) | Only the desktop window. |
| This computer only | A browser on this computer. |
| This computer and trusted networks | Also devices on the private networks you turn on one by one: your local network or Tailscale. Public addresses are never offered. |

Every browser must be paired with a one-time code (shown as a code, a link and a QR code), and
each paired device can be removed at any time, which disconnects it at once. Local-network
traffic is plain HTTP, so anyone on that network can read it; use Tailscale when you need the
connection encrypted. Paired devices are kept as hashes only, in `web-access.json` in the
Desktop folder.

## Where data lives

Everything is in one Desktop folder. Jouzu's own data is the `data` folder inside it.

| | Windows | macOS and Linux (development only) |
| --- | --- | --- |
| **Desktop folder**: the installed runtime (Node.js and the `jouzu` npm package) and its updates, recent folders, update channel, web access settings and paired devices, logs | `%LOCALAPPDATA%\Shisa.ai\JouzuDesktop` | `~/Library/Application Support/Shisa.ai/JouzuDesktop` (macOS), `$XDG_DATA_HOME/Shisa.ai/JouzuDesktop` (Linux, default `~/.local/share/...`) |
| **Jouzu home**: sessions, settings, sign-ins and API keys, tools settings | `JOUZU_HOME` if set, otherwise `data\` in the Desktop folder | `JOUZU_HOME` if set, otherwise `data/` in the Desktop folder |

- The Jouzu home is where every Desktop release since 1.0 has kept it, and the `jz` and `jouzu`
  commands that Desktop installs use the same one, so they show the same sessions. A different
  `JOUZU_HOME` is followed as is.
- The Jouzu home does not move between releases, and Desktop never copies data into it or out
  of it. A session continues only in the home it was created in, so a copied session opens but
  cannot go on.
- Desktop does not read the home of the earlier Jouzu Launcher (`%LOCALAPPDATA%\Shisa.ai\Jouzu`)
  or of a `jouzu` you installed yourself with npm. Their sessions stay where they are.
- Uninstalling keeps the Jouzu home unless you choose to delete app data.
- `logs/` in the Desktop folder holds the app and host logs (`host.log` records timing for every
  session step) and any crash records. **Settings → System → Open the log folder** opens it.

## Repository layout

```text
apps/desktop/              the desktop app
  src/                      React UI
  src-tauri/                Tauri shell (Rust)
  host/                     jouzu-host (Rust)
  e2e/                      Playwright specs and the user playbook
  e2e-runtime/              acceptance scripts against a real Jouzu runtime
  scripts/                  build and development helpers
packaging/desktop/         installer, update feed and release tooling
scripts/                    repository test runner used by CI
.github/workflows/          development and release gates
CHANGELOG.md                user-facing changes per release
```

## Development

Requirements: Node.js 24, Rust (stable), and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
cd apps/desktop
npm ci
npm run dev:isolated   # run the app with its own data folder, never your real one
```

`dev:isolated` keeps everything, including the Jouzu home, under a separate `JouzuDesktopDev`
folder (override with `JOUZU_DESKTOP_DEV_HOME`), so a development run cannot touch an
installed app or your real Jouzu sessions.

### Tests

```bash
cd apps/desktop
npm test                      # UI unit tests (Vitest)
npm run build                 # typecheck and production UI build
npm run test:e2e              # Playwright specs against a stubbed host
cargo test --manifest-path host/Cargo.toml
cd src-tauri && cargo test --locked --bins

# from the repository root: packaging and release tooling tests
npm run test:node -- packaging/desktop/*.test.mjs
```

Acceptance against a real, released Jouzu runtime is opt-in and never runs against a paid
provider: see [`apps/desktop/e2e-runtime/README.md`](apps/desktop/e2e-runtime/README.md).
The user playbook (`npm run playbook`) drives the running app through accessible controls
only, the way a user would, and records timing for each scenario.

### Building an installer

```bash
cd apps/desktop
npm run tauri build
```

`scripts/build-app.mjs` runs first and builds the UI and the host from the same tree, stamping
both with one build id.

## Continuous integration

- **Development gate** (`desktop-checks.yml`, every pull request): debug build, unit tests,
  host and shell tests, mocked UI specs. Kept fast.
- **Release gate** (`desktop-release.yml`, `desktop-stable.yml`, `dependency-audit.yml`):
  QA release candidates with the QA icon and their feed; stable builds rebuilt from a QA
  candidate, examined with the full user playbook and a real model before the stable feed
  moves; dependency audit.

## Contributing

Report problems as [GitHub issues](https://github.com/shisa-ai/jouzu-desktop/issues)
(**Settings → System → Report a problem** opens the page). Include the app version, the steps
to reproduce, and the relevant part of `logs/` or the crash record if there is one; never paste
API keys.

Pull requests target `develop`; `main` holds released code only. A bug gets an issue before it
gets a fix, the fix names the root cause, and every closed issue gets a regression check. See
[CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

Apache-2.0. Bundled third-party components are listed in
[`packaging/desktop/NOTICES.md`](packaging/desktop/NOTICES.md).
