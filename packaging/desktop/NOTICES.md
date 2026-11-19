# Third-party components

Jouzu is distributed under Apache-2.0. The jouzu npm package contains LICENSE and
THIRD_PARTY_NOTICES.md with notices for the agent and its extensions.

The desktop installer carries none of the components below. On first run, Jouzu Desktop downloads
these unmodified upstream components into its install folder, verified by digest, and each keeps
the licence and copyright files shipped inside it.

- Node.js and npm: https://nodejs.org/ and https://github.com/npm/cli
- PortableGit and Git Bash: https://gitforwindows.org/ (includes GPL-licensed Git, Bash and supporting tools; source releases are available from https://github.com/git-for-windows/git/releases)
- Windows Terminal: https://github.com/microsoft/terminal (MIT); the portable archive is used unmodified and keeps its own licence files

The Tauri bundler produces the installer with NSIS: https://nsis.sourceforge.io/.

Versions and digests are pinned where each is installed: Node in
`apps/desktop/src-tauri/src/runtime_install.rs`, PortableGit in `git-environment.ps1`, Windows
Terminal in `terminal-environment.ps1`.
