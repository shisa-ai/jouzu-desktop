# Jouzu Desktop release channels

Jouzu Desktop has two update feeds for one application:

| Channel | Feed | Who follows it |
| --- | --- | --- |
| Stable | `releases/download/desktop-update/latest.json` | Every installation by default |
| QA | `releases/download/desktop-update-qa/latest.json` | Installations switched to QA in Settings → System |

QA is not a separate product. It uses the same install directory, the same user data, the
same sign-ins, so what QA tests is the upgrade a real user will take. Switching is a setting
(`update-channel.json` in the managed root); a missing or unreadable setting means stable.

## How a release moves

1. **Publish to QA.** Run *Desktop release* with `publish`. It builds, signs, creates the
   prerelease `v<version>` and replaces the QA feed. It never writes the stable feed.
2. **Test on QA.** Switch an ordinary installation to QA, let it upgrade in place, and run the
   acceptance checklist on the user's own data.
3. **Promote.** Run *Desktop promote to stable* with the version and what passed on QA. It does
   not build: it points the stable feed at the same installer and signature, verified against
   the published checksum and the updater key, and marks the release stable.

## Rules the workflows enforce (`release-guard.mjs`)

- A QA build must be newer than what both feeds serve, and its tag must not exist yet. A
  published build is never replaced.
- Promotion requires a QA prerelease that the QA feed has offered, and a version newer than
  stable. Stable never moves backwards.
- Versions are plain `MAJOR.MINOR.PATCH`, increasing across both channels.

## Rules for QA builds

- A QA installation follows the newest of the QA and stable feeds, so a promoted release
  reaches it too.
- Switching back to stable offers the current stable build even when it is older, marked as
  going back; nothing installs until the user asks.
- Because QA shares the user's data, a QA build must not change stored data in a way the
  current stable cannot read. A data format change ships with a version marker and stays
  readable by stable, or it waits.
