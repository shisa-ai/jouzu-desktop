# Released-runtime acceptance harness

These scripts exercise the desktop against an **official extracted Jouzu setup**. They are
opt-in; the default unit suites stay hermetic.

## RPC matrix

```powershell
$env:JOUZU_E2E_RUNTIME = '<extracted official setup>'
$env:JOUZU_E2E_HOME = '<isolated home>'
$env:JOUZU_E2E_WORKSPACE = '<workspace folder>'
npm run test:runtime
```

Covers `get_state`, `prompt` (success without `data`), `steer`, `abort`, `clear_queue`,
`new_session`, `get_messages`, `switch_session` with restored history, model catalog and
`set_model`, `compact` (or its small-session guard), and `export_html` with a written file.
It starts a loopback OpenAI-compatible server and a test-only provider extension; it never
contacts a paid provider, installs anything, or patches the runtime. Results are written to
`rpc-matrix-result.json`.

## UI flow

Prerequisites:

1. The app is running with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`.
2. An isolated profile has a provider pointing at `http://127.0.0.1:43123/v1` with model
   `deterministic` and a saved fixture key.
3. The fixture server is running:
   `JOUZU_FIXTURE_PORT=43123 node e2e-runtime/fixture-server.mjs`

```powershell
npm run test:ui
```

Covers opening into a prewarmed workspace, model selection, prompt streaming, a real tool
call, steering while running, Stop/abort, New chat and continuation. Results are written to
`ui-flow-result.json`.

The native Resume file picker is not automatable through CDP; `switch_session` is covered by
the RPC matrix and the picker is checked by hand during release acceptance.

## Language settings

```powershell
$env:JOUZU_E2E_RUNTIME = '<extracted official setup>'
node e2e-runtime/language-settings.mjs
```

Uses a throwaway `JOUZU_HOME`. Saves reply and artifact language through the desktop control
adapter and checks that a new runtime's system prompt carries those instructions; then saves a
change the way Jouzu's own Settings does and checks the desktop reads it and the next runtime
uses it. Results are written to `language-settings-result.json`.

## Entry session after a startup restart

```powershell
$env:JOUZU_E2E_HOST_HOME = '<home of a host started on a throwaway data folder>'
node e2e-runtime/entry-restart.mjs
```

Needs a model-ready throwaway home (fixture provider) and the fixture server. Sends one
message so the workspace has an entry session, then reopens the page while the first
session lease is held for 4 s (#73; a catalog revision activated at startup no longer
restarts the chat, so that half of the original order is gone). Passes when the loader is gone and the
entry session was opened. Results are written to `entry-restart-result.json`.

## Turn files stay with their session

```powershell
$env:JOUZU_E2E_HOST_HOME = '<home of a host started on a throwaway data folder>'
$env:JOUZU_E2E_WS_A = '<workspace A>'; $env:JOUZU_E2E_WS_B = '<workspace B>'
node e2e-runtime/turn-files-session.mjs
```

Needs the fixture provider and server, and both folders added as workspaces. Runs a turn in B,
then a turn in A during which a file in A is written, then opens B's session: A's summary must
list the file and B's must not (#79). Results are written to `turn-files-session-result.json`.

## Model list follows settings

```powershell
$env:JOUZU_E2E_HOST_HOME = '<home of a host started on a throwaway data folder>'
node e2e-runtime/model-list-fresh.mjs
```

Needs a model-ready throwaway home. Lists the models, adds a provider and its key through the
control API, lists again (the provider must be there), removes the key and lists again (it must
be gone), with no restart (#84). Results are written to `model-list-fresh-result.json`.

## First new session after start has a model

```powershell
$env:JOUZU_E2E_HOST_HOME = '<home of a host JUST started on a throwaway data folder>'
$env:JOUZU_E2E_WORKSPACE = '<workspace folder>'
node e2e-runtime/first-session-model.mjs
```

Needs a model-ready throwaway home. Creates a new session, the order of the first app start: its
model must go from "resolving" to "ready" with the model its runtime reports, without anything
sent (#99). Results are written to `first-session-model-result.json`.
## A refused image does not trap the session

```powershell
$env:JOUZU_E2E_HOST_HOME = '<home of a host started on a throwaway data folder>'
$env:JOUZU_E2E_WORKSPACE = '<workspace folder, added as a workspace>'
node e2e-runtime/rejected-image.mjs
```

Needs the fixture provider (model input `["text","image"]`) and the fixture server, which
refuses any request carrying a PNG with a side of 10 px or less, with the provider text from
#17. The model reads a 256×1 PNG with the read tool; the refusal must be shown above the
composer with "Remove images" and "New session", a second message must fail the same way
without hanging, and after "Remove images" the next message must get a reply. Results are
written to `rejected-image-result.json`.
