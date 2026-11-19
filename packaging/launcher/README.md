# Desktop packaging

Jouzu Desktop ships only the app (shell, host and UI). Its installer carries no runtime; the jouzu
runtime is installed from npm on first run (ADR 0003). This directory holds what the desktop build,
its release workflows and its first-run setup use:

| Files | Used by | Purpose |
| --- | --- | --- |
| `installer.nsi`, `desktop-installer-hooks.nsh` | Tauri bundler | The NSIS installer and its install/uninstall hooks |
| `desktop-feed.mjs`, `release-guard.mjs`, `verify-feed.mjs`, `verify-updater-signature.mjs`, `set-version.mjs`, `launcher-notes.mjs` | Release workflows | Update feeds, release rules, version and release notes ([RELEASE-CHANNELS.md](RELEASE-CHANNELS.md)) |
| `bootstrap.mjs`, `control.mjs` | Shell and host (embedded at build time) | Start the runtime; answer configuration requests |
| `git-environment.ps1`, `extract-portable-git.ps1`, `terminal-environment.ps1`, `command-path.ps1`, `command-entries.ps1` | Shell (embedded, written into the install on first run) | Git Bash, Windows Terminal and the `jz`/`jouzu` commands |
| `extensions/jouzu-image/` | Shell (embedded) | The image tool extension |

The remaining scripts (`open-terminal.mjs`, `bug-report.mjs`, `update-service.mjs`,
`check-update-health.mjs` and the recipe update scripts they import) are called by the shell at
paths the desktop install never writes. Whether to ship or remove each one is tracked separately.

## Validation

```sh
npm run test:node -- packaging/launcher/*.test.mjs
```

`Desktop Windows checks` builds the frontend and the Windows binaries, runs these packaging tests
and the Rust tests, and exercises the interface with mocked IPC. A green check is not installed
upgrade acceptance: install the previous release, upgrade in place, and check the user's data,
Git Bash, terminal and `jz` afterwards.
