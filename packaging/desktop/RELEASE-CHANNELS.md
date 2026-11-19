# Jouzu Desktop release channels

Jouzu Desktop has two update feeds:

| Channel | Feed | Who follows it |
| --- | --- | --- |
| Stable | `releases/download/desktop-update/latest.json` | Every installation by default |
| QA | `releases/download/desktop-update-qa/latest.json` | Installations switched to QA in Settings → System |

The installed package and the update channel are independent. The channel is a setting
(`update-channel.json` in the Desktop folder, `%LOCALAPPDATA%\Shisa.ai\JouzuDesktop`); a
missing or unreadable setting means stable, whatever package was installed. Switching it
changes only which feed the app updates from; the install folder, Jouzu's data and sign-ins
stay the same.

## Packages

QA and stable packages are built from the same code. They differ in exactly three ways:

| | QA package | Stable package |
| --- | --- | --- |
| Version | `X.Y.Z-rc.N` (a release candidate) | `X.Y.Z` |
| Icon | Jouzu icon with a **QA** badge, set when the package is built | The normal Jouzu icon |
| Code signing | Updater signature | Updater signature, and SmartScreen (Authenticode) once the certificate is available |

There is no QA or stable switch inside the app: what a package looks like is decided when it
is built.

## How a release moves

1. **Publish a QA release candidate.** Run *Desktop release* with `publish` and a version
   `X.Y.Z-rc.N`. It builds the QA package (QA icon), creates the prerelease `v<X.Y.Z-rc.N>`
   and replaces the QA feed. It never writes the stable feed.
2. **Test on QA.** Switch an installation to QA, let it upgrade in place, and run the
   acceptance checklist.
3. **Release stable.** Run *Desktop stable release* with the candidate that passed and what
   passed on QA. It builds the stable package `X.Y.Z` again from that candidate's commit,
   with the normal icon, and runs the full user playbook on it with a real model, on every
   platform the desktop ships. Only if every scenario and gate passes does it publish
   `v<X.Y.Z>` and replace the stable feed. SmartScreen signing joins this build once the
   certificate exists.

## Rules the workflows enforce (`release-guard.mjs`)

- A QA release is a release candidate `X.Y.Z-rc.N`, newer than what both feeds serve, with a
  new tag. A published build is never replaced.
- A stable release `X.Y.Z` needs the published QA prerelease `v<X.Y.Z-rc.N>`, a new tag, and a
  version newer than stable. Stable never moves backwards.
- Versions follow semver order: `1.1.3-rc.1 < 1.1.3-rc.2 < 1.1.3 < 1.1.4-rc.1`, so a QA
  installation moves on to the stable release without a version conflict.

## Rules for QA builds

- A QA installation follows the newest of the QA and stable feeds, so a stable release
  reaches it too.
- Switching back to stable offers the current stable build even when it is older, marked as
  going back; nothing installs until the user asks.
- Because QA and stable share the user's Jouzu home (which `jz` uses too), a QA build must not
  change stored data in a way the current stable cannot read. A data format change ships with
  a version marker and stays readable by stable, or it waits.
