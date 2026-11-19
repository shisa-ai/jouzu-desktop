# Jouzu Desktop: the product

What the product is, what it promises, and which features must never disappear. How
each layer delivers it is in [`design/`](design/); why things are the way they are is
in [`decisions/`](decisions/).

## 1. What it is

Jouzu Desktop is a **local-first desktop client for the Jouzu agent**. It gives one
person a persistent chat workspace where the agent can use tools, run Flow and
TextGuard, produce artifacts and keep working while the window is closed, reloaded or
recreated.

It is not a web dashboard, a model marketplace, a multi-user server or a second agent
runtime. It is the desktop surface for one local Jouzu installation, also reachable
from a paired browser ([0008](decisions/0008-remote-access.md),
[0021](decisions/0021-web-and-remote-are-one-client.md)).

## 2. Who it is for

A single technical or semi-technical desktop user with a Jouzu model connection, who
uses the app for long-running coding, writing and tool work across several sessions
and folders, and cares that work continues when the window does not. They may be
running games or other heavy programs at the same time.

What they come to do:

1. Start a conversation without ceremony.
2. Switch between sessions and folders, see an old conversation, and continue it.
3. Supervise tools: see progress, approve or deny, answer questions, stop a turn.
4. Use Flow, TextGuard and subagents from the same chat.
5. Find and use outputs: images and files, reveal or open them, quote them back.
6. Set up the model source once, and recover when something fails.

## 3. Promises

| Promise | Meaning |
| --- | --- |
| Ready at once | A new session shows its model and accepts a message the moment it opens ([0016](decisions/0016-new-session-ready-at-once.md)) |
| Reload-safe | A page reload or window recreation never stops a turn or a session |
| Durable | A message shown as accepted is kept by the host before the UI moves on |
| Concurrent | No session blocks another; no path refuses a session because of a count ([0004](decisions/0004-chat-view-concurrency.md)) |
| One surface | One app and one chat; no fallback or secondary page |
| Feature floor | Every feature reachable in 1.0.7–1.0.22 stays reachable (section 5) |
| Local data | Sessions, artifacts, credentials and settings stay in one home, never copied ([0018](decisions/0018-one-data-home-never-copied.md)) |
| Honest | The app shows what the runtime gives, adds no invented limits, and says plainly when something is unavailable ([0015](decisions/0015-runtime-facts-relayed-not-reinterpreted.md)) |
| Failures in place | An error shows where it happened, once, in plain localized words, with an action that can succeed; nothing else stops and nothing moves ([0017](decisions/0017-errors-at-their-scope.md)) |
| No leftovers | An unused new session leaves no row in the session list |

When choosing between approaches, decide by speed, correctness and usability for the
person, in that light; align with the goals the earlier versions met, not with their
algorithms.

## 4. Surfaces

- **Chat**: conversation, composer, model and thinking level, tools, approvals and
  questions, Flow and TextGuard.
- **Session sidebar**: folders, sessions, search, sort, pin, archive, rename,
  running state, artifact counts.
- **Settings**: providers and account, tools and images, environment, general,
  system.
- **Artifacts and files**: session outputs; open, reveal, delete, quote.
- **Start**: runtime preparation and model setup inside the same app.
- **Tray and window**: show, new session, quit; closing the window hides to the tray.

An unavailable capability is shown as unavailable inside the same surface, never as a
dead control.

## 5. Feature floor

These are requirements, not wishes. A feature not yet delivered shows an explicit
unavailable state; it is never dropped silently.

- Chat: send, steer, stop, markdown, thinking, streaming, tool cards, error and
  capacity messages.
- Composer: images (up to 4), paste and drop, drafts, compact, export, reload, model
  and thinking level.
- Sessions: list, group, search, sort, new, preview, open, switch, pin, archive,
  rename, copy id, running state, artifact badge, fork, recover, timing.
- Prompts: approvals, questions, deadlines, duplicate prevention, first valid answer,
  image-tool review.
- Flow, TextGuard, subagents and background work: menus, reports, notices, review
  actions. Only a person approves, releases or recovers; the agent never approves its
  own held work.
- Artifacts and files: panel, viewer, quote, reveal, delete, counts.
- Settings: providers and account, tools and images, environment, language, system,
  updates.
- Start: connecting, preparing, model setup, update banner.
- Shell: tray show, new and quit, close to tray, single instance, title bar, drag and
  drop.

## 6. Scope

In scope: Windows first (macOS and Linux follow); one local user, one installation,
one data home; one local host serving one app; a narrow shell bridge for native
actions; LAN and tailnet access with pairing.

Out of scope: public internet exposure before a security review; multiple users,
organizations or shared sessions; a provider marketplace; a second UI; a required
cloud account or sync service; bundling Node or the runtime in the installer
([0003](decisions/0003-no-bundled-runtime.md)); changing the runtime's agent logic
from the desktop.

## 7. Words

- **Runtime**: one jouzu process for one session; owns models, configuration and
  agent behaviour.
- **Host**: the local process that serves the app and owns session state.
- **Shell**: the Tauri app; window, tray, updater and native bridge.
- **UI**: the one React app served by the host.
- **Warm runtime**: a runtime started ahead of time for a recent folder, so a new
  session is ready at once.
- **Native action**: an OS action only the shell can perform.
