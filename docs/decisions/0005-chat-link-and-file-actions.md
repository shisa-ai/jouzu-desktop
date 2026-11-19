# ADR 0005 — Chat links open through one validated native boundary

> Migrated on 2026-11-19 from the former planning repository, unchanged except for
> this note and the status line. Links to `spec/`, `contracts/` and `tasks/` point to
> drafts that were not migrated; the current design is in [`../design/`](../design/).

Status: Accepted  
Date: 2026-10-27

## Context

Transcript content is model output and is untrusted. It contains ordinary links
(the reported case is a dev server at `http://localhost:8100`), documentation
URLs, and file paths for artifacts the turn produced.

Today the webview calls `openUrl` from `@tauri-apps/plugin-opener` directly
(`chat-markdown.tsx`, `App.tsx`, `report.ts`). The capability
(`apps/desktop/src-tauri/capabilities/default.json`) allows exactly two URL
patterns:

```text
https://platform.shisa.ai/connect*
https://github.com/shisa-ai/jouzu/*
```

Every other link fails, including every `http:` link and every host the agent
prints. The failure is a local "Could not open link." — the browser is never
asked. There is no file-reveal capability at all, so a generated file can only
be found by copying the path.

The two operations we need are not the same risk:

- opening a URL hands an arbitrary string to the OS default handler;
- revealing a path hands a path to the file manager, which selects an item and
  reads nothing.

A capability allowlist per host is the wrong tool for chat output: the set of
legitimate hosts is the whole web, and the allowlist cannot express "http(s)
only, no credentials, no custom schemes" anyway. Adding `https://*` and
`http://*` to the JS-facing capability would give any script in the webview a
general-purpose launcher with no argument validation, no logging and no testable
policy.

## Decision

- Chat content never calls the opener plugin directly. It calls two native
  commands, and the policy lives in Rust:
  - `open_external_url { url }` — allows `http:` and `https:` only, rejects
    embedded credentials, `file:`, `javascript:`, `data:`, `blob:`, `mailto:`,
    `tel:` and any unknown scheme. Opens with the OS default handler. It also
    allows `http://localhost` and `http://127.0.0.1` (the reported case).
  - `reveal_path { path }` — allows an existing file or directory only. The path
    is canonicalized; the command never reads contents, never runs a shell and
    never launches the file's own handler. On Windows it selects the item in
    Explorer through the shell API, not through an `explorer.exe` command line;
    on macOS it uses `open -R`; on Linux it opens the parent directory.
- The JS-facing capability stays narrow. The two fixed flows (`platform.shisa.ai`
  connect and the project issue URL) may keep using `openUrl`; new chat surfaces
  use the native commands. No `*://*` scope is added to the capability.
- A Rust-side call bypasses the plugin's JS scope, which is intentional: the
  validation that matters (scheme, credentials, existence, path traversal) is
  the command's own and is unit-tested. Calling the plugin from Rust without
  validation is forbidden.
- Failure is reported to the caller as a typed reason
  (`unsupported-scheme | credentials | not-found | too-many-redirects |
  open-failed`) so the UI can show one inline sentence and a copy action.
- "Open the file in its default application" is **not** granted by this ADR. It
  is a different risk (executing the generated content) and needs its own
  decision.

## Consequences

- Chat links work for the web at large; users stop copying URLs out of the app.
- Localhost dev servers are usable from the transcript.
- Every URL and path that reaches the OS passes one auditable function with a
  test table covering the scheme matrix.
- `mailto:` and `tel:` do not open. If that is wanted later, it is an ADR change,
  not a capability tweak.
- The native boundary implements the two commands; their consumers are not allowed
  to call `openUrl` for their own content.
- A custom URL scheme used by a future feature does not get a silent pass; it
  needs an entry here.
