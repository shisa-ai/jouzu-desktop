# jouzu-host

The host sits between the Jouzu Desktop UI and the jouzu runtime. It owns every chat session
and the runtime process behind it, so a session's life does not depend on any window: closing
or reloading the UI never stops a reply, and a UI that reconnects catches up from the host.

```text
UI  ──HTTP /v1 + SSE──▶  jouzu-host  ──JSON-lines RPC over stdio──▶  jouzu runtime
```

The desktop shell starts one host per installation and serves the UI from it. The host is a
separate binary with its own HTTP contract, so another client can drive the same sessions.

## What it does

- **Sessions.** One runtime process per session, held in a Windows Job Object (a no-op
  elsewhere) so stopping a session or the host ends the whole process tree. Detaching a client
  never stops a session.
- **One event stream.** `GET /v1/events` carries every session and control event with a global
  sequence. A client resumes with `Last-Event-ID`; a gap older than the ring produces a resync
  instead of a silently incomplete stream. Content is sent only to a client viewing that
  session; state (status, turns, summary) goes to every client, so a sidebar always knows which
  sessions are running.
- **Queue.** A message sent while a reply is running is held in a visible queue and delivered
  once, at the next step. Stop keeps queued messages so the user can continue or discard them.
- **Prompts.** Runtime confirmations become approvals (`approval.requested` / `.resolved`);
  select, input and editor prompts become questions (`question.requested` / `.answered` /
  `.cancelled`). The runtime's own timeout is used when it gives one, otherwise 120 s.
- **Recovery.** A runtime that dies is restarted. One that dies three times within five
  minutes stops the session with an error the user can retry, rather than restarting forever.
- **Warm runtimes.** A runtime loads its extensions for one folder, so the host keeps one
  ready for each recently used folder (up to four, plus spares for the most recent), and
  starts the first one while the window is still loading.
- **Control.** Jouzu configuration (sign-in, models, tools, language) runs through the host
  one operation at a time, with progress and device codes reported as events.
- **Web access.** Off by default. In Settings → Web access the user can let a browser on
  this computer, or devices on trusted networks they turn on (private LAN ranges and
  Tailscale; never a public address or a wildcard bind), use the same UI on a persistent
  port. Every browser is paired with a one-time code and gets its own credential, stored
  only as a hash in `web-access.json`; paired devices can be removed one by one or all at
  once, which also ends their open event streams. The desktop window keeps its own
  loopback listener and token, which web listeners never accept.
- **Timing.** Every step is logged with its timing to `logs/host.log`, in development and
  release builds alike.

## Running it

Build the UI first (`npm run build` in `apps/launcher`), then from `apps/launcher`:

```powershell
cargo run --manifest-path host/Cargo.toml -- --dist dist --home <host home> `
  --runtime-home <jouzu data folder>
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--dist` | Built UI to serve | `./dist` |
| `--home` | The Desktop installation: `host.json`, `host.lock`, `logs/`, and the installed runtime (`runtime/node`, `app`) | `JOUZU_HOST_HOME`, then `%LOCALAPPDATA%\Shisa.ai\JouzuDesktop` |
| `--runtime-home` | `JOUZU_HOME` given to the runtime (sessions, settings, credentials). The host never copies or moves it | `JOUZU_HOME`, else `<home>/data` |
| `--runtime`, `--runtime-arg` | Runtime program and arguments | the runtime installed under `--home`, looked up when a session starts |
| `--bash` | Git Bash to give the runtime | discovered |

Use a throwaway `--home` and `--runtime-home` for experiments; never point a development host
at a real installation's data.

The window's listener is loopback only, and the host prints its URL. `host.json` in the home folder names the
port and a per-run token:

```powershell
$h = Get-Content <host home>\host.json | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($h.port)/v1/health" -Headers @{ Authorization = "Bearer $($h.token)" }
```

Opening `http://127.0.0.1:<port>/?token=<token>` in a browser exchanges the token for an
`HttpOnly` cookie, after which `/v1/...` accepts the cookie.

Only one host runs per home: an exclusive `host.lock` is taken before the listener binds. A
second start exits with the live process id and port and leaves `host.json` alone; a lock left
by a dead process is reused. A clean exit removes both files.

A release shell starts only the host built with it (both carry the same build id from
`scripts/build-app.mjs`), so an installation never pairs a UI with a host from another build.

## API outline

All endpoints are under `/v1` and need the bearer token or the cookie. `GET /v1/capabilities`
reports the contract version, the runtime kind and the supported features.

```text
GET  /events                         one SSE stream for all sessions and control
GET  /sessions                       live sessions
POST /sessions                       { workspacePath, sessionPath? }  -> 202
GET  /sessions/persisted             saved sessions per workspace
GET  /sessions/{id}                  status, pending approvals and questions
GET  /sessions/{id}/messages         history, paged
POST /sessions/{id}/messages         { clientMessageId, text, attachments? }  -> 202 with a receipt
GET  /sessions/{id}/attachments/{attachmentId}  an image of a user message in history: { id, mimeType, data }
POST /sessions/{id}/interrupt | /cancel | /stop | /queue
POST /sessions/{id}/model | /thinking | /compact | /export | /reload
POST /approvals/{id}/decision        { clientId, decision }
POST /questions/{id}/answer          { clientId, answers }
GET  /models (the running runtime's own list)
GET|PUT /tools, GET /mcp, GET|POST /workspaces
POST /control, POST /control/cancel
```

A client that answers prompts declares the `prompts` capability when it attaches
(`?clientId=...&capabilities=view,control,prompts`). A duplicate answer returns
`409 prompt-resolved`, a late one `409 prompt-expired`.

## Runtime adapter

The host speaks the runtime's RPC mode (`--mode rpc`): JSON lines on stdio, with
`prompt`, `steer`, `abort`, `get_messages`, `switch_session` and friends, and the runtime's
`agent_*`, `message_*` and `tool_execution_*` events. All of that wire vocabulary lives in
`src/runtime/adapter/`; the session core does not depend on it, so another runtime can be
plugged in by adding an adapter.

## Tests

```powershell
cargo test --manifest-path host/Cargo.toml
```

Tests run against `tests/fixtures/fake-runtime.mjs`, which speaks the same RPC wire shapes as
the real runtime, not a private protocol. `FAKE_RUNTIME_UI=confirm|select|input|editor|noise`
makes it raise prompts and wait for the host's answer. Acceptance against a real runtime is in
[`../e2e-runtime/README.md`](../e2e-runtime/README.md).
