# Changelog

## 1.1.4 - 2026-11-20

Stable release. It follows 1.0.23 on the stable channel and contains everything from 1.1.0
to 1.1.4-rc.1 (the QA channel's release candidates), listed step by step in the changelog. It
was built again from the commit of 1.1.4-rc.1, which passed QA. Your sessions, settings and
sign-ins stay where they are.

- Chats keep running on their own. Closing or reloading the window no longer stops a reply,
  and a window that reconnects catches up. If the model runtime stops, the session recovers
  with its messages and its model, and a message that got no reply offers Retry.
- A new session can send at once. Its model shows right away and the model picked last is
  used from the first message. Recent folders are kept ready, so opening a session there does
  not wait for the model runtime to start.
- Messages sent while a reply is running wait in a visible queue and are delivered once; Stop
  keeps them so you can continue or discard them. Stop pressed right after Send stops the
  reply.
- Each problem is shown once, where it happened, in the interface language, with the action
  that recovers it: a failed reply on the reply with Retry, a session that cannot recover with
  Restart session, a setting that cannot be saved on its own form. Nothing moves when an error
  appears. Provider errors, including the Shisa.AI plan, balance and capacity errors, are
  named plainly.
- A model refresh or a key or provider change reaches sessions that are already open. Settings
  actions run one after another instead of failing because another one is running.
- Settings has a Language page for the interface and reply language, shared with Jouzu in a
  terminal, and a Web access page to allow a browser on this computer or on trusted networks,
  each paired with a one-time code. Web access stays off until you turn it on.
- The image tool offers every provider your account can generate images with, and says why
  any other one cannot be used. Images in a message stay visible after switching sessions or
  reloading. When a model refuses an image, the session offers Remove images or New session.
- Long sessions can be read back to their first message. Saved sessions open on the model they
  last used, including sessions written by older versions or cut off mid-line.
- After the computer wakes from sleep, the chat no longer stays on "Starting session...".
- Fewer background model runtimes: a session no window shows gives its runtime back after
  about a minute.
- Settings → System has an update channel. QA receives release candidates before stable; you
  can switch back to stable at any time.

## 1.1.4-rc.1 - 2026-11-19

First release candidate for 1.1.4, on the QA channel. It replaces 1.1.3-rc.3, which did not
pass its evaluation (#160).

- A new session can send at once. Its model shows right away, from what the runtimes last
  reported; a message sent while the model is still resolving is held and sent on the right
  model, and the model picked last is applied before the first message (#99, #143). A model
  refresh or a key or provider change now reaches sessions that are already open (#144).
- A session keeps its messages, its model and a message that got no reply when its runtime
  exits or restarts. Send stays usable meanwhile (#154). A runtime that dies under a session
  nobody has open is started again only when that session is used, so the session in use is
  back within seconds when every runtime goes down together.
- Each problem is shown once, where it happened. A failed reply says why on the reply, in the
  interface language, with what recovers it and Retry (#151, #152). A session whose runtime
  cannot recover shows one error with Restart session (#156). Nothing moves when an error
  appears (#147, #153). A session that cannot open at start says why instead of loading
  forever (#166).
- Provider errors are read from their codes, including the Shisa.AI router's plan, balance and
  capacity codes. A refused Shisa.AI sign-in shows on its card.
- Settings that cannot be saved are reported on the provider's form, with the file and the
  system's code under Details (#155). The main window and the Tools page follow the interface
  language (#100), and the Tools page says why an image provider is unavailable (#157). The
  Tools page also works with a custom data home (#163).
- Saved sessions whose last line was cut off, or that were written by an older version, are
  listed and open with their history (#150, #164).
- When the downloaded runtime is incomplete, setup downloads it again instead of failing on a
  missing npm.
- The host's API token is no longer written to a file (#130).
- Acceptance measures a new session from the New session click, with Send usable at once, and
  the #99 limits are restored (#148).

## 1.1.3-rc.3 - 2026-11-18

Third release candidate for 1.1.3, on the QA channel.

- Errors are shown where they happened and no longer pile up above the composer. A session
  that ended with an error takes the composer's place with the reason and the one action that
  recovers it; a message that was not sent is marked on that message with Retry and Discard; a
  reply that failed is shown at the end of the conversation; a model, Stop or command that did
  not take effect is marked at its own control. None of these moves the layout, and all of
  their text is in English, Japanese and Chinese (Simplified and Traditional), with the
  runtime's original words behind Details. Desktop no longer limits a message to 32 KiB; what
  fits is up to the runtime and the model (#62). The chat no longer shifts sideways on a
  horizontal swipe (#113).
- The model menu shows exactly the models the session's runtime offers, so every listed model
  can be selected, and an empty list on a cold start is gone. Until the runtime has reported
  its model, Send waits and the model button shows that it is loading; with no model set up it
  offers Settings. A new session uses the model picked last when its runtime offers it.
- A message sent while the runtime is running a turn on its own (for example a Flow step) is
  queued and handed to that turn instead of being refused, and that turn is shown and can be
  stopped.
- The workspace menu on the new-session screen stays inside the window and scrolls on its own
  (#114).
- Settings actions run one after another instead of failing with "Another configuration
  operation is running": the host queues every configuration change (keys, sign-in, catalog
  refresh, default model, language, profile, environment variables) and each card waits only for
  its own actions and shows its own failure. Environment variables are saved in the same queue, so a
  model refresh after saving a key uses the new key (#63). Configuration changes reach new
  sessions; open sessions are no longer restarted behind the person's back.
- The stable release exam now enforces the host's part of a first reply (message accepted to
  the model request, from host.log; median 200 ms, slowest 400 ms) instead of only showing
  it in the report (#129).

## 1.1.3-rc.2 - 2026-11-16

Second release candidate for 1.1.3, on the QA channel.

- Sessions from earlier Desktop versions are back. 1.1.3-rc.1 looked for Jouzu's data in a
  different folder, so everything created before it was missing from the list. Desktop uses
  the folder it has always used again (`data` in the Desktop folder, or `JOUZU_HOME` when
  set), does not move it between releases and never copies data into or out of it (#112).
- The first message in a new session reaches the model sooner. When the folder has a warm
  runtime ready, a new session attaches to it as soon as it is created, so sending only hands
  over the message instead of first switching the runtime to the session (#117). A new
  session left without a message gives its runtime back as soon as no window shows it.
- Playbook timings are judged by what the app controls: own message and the turn visibly
  working by the median of five new sessions, and the host's part of a reply from host.log.
  The answer's own time (provider and model) is recorded, not gated (#97).

- After the computer wakes from sleep the chat no longer stays on "Starting session…". Idle
  time no longer counts time asleep, the session in the window is kept while the window
  reconnects, and a session that was stopped is reopened automatically (#111).
- Images in a message stay visible after switching sessions, reloading, or opening the
  session in a browser. The host serves each image by id and no longer puts local file paths
  in history (#119).
- A session that fails no longer leaves its turn waiting with a running timer. It shows one
  alert above the composer with the reason and a "Restart session" action, and a session
  file the runtime refuses is not retried in a loop (#95).
- Fewer background runtimes. A session no window shows gives its runtime back after about a
  minute; two runtimes no longer start side by side for the same settings; a folder written
  two ways counts as one; stopped or failed sessions no longer leave a runtime running; an
  empty new session no longer leaves its file behind (#92, #93, #94, #98).
- When the model refuses an image, the error above the composer offers "Remove images" and
  "New session" for any image refusal, not only some wordings. "Remove images" replaces the
  images in the session with a short note (a backup of the file is kept), so the session can
  continue (#17).
- A long session can be read back to its first message: scrolling up loads earlier pages,
  for open and saved sessions. Branching from an earlier message copies the conversation up
  to the end of that turn (#20).
- Stop pressed right after Send now stops the reply. A Stop that reached the runtime before
  the run had started was lost, so the reply streamed to the end (#61).
- The first new session after start gets the default model. When a message cannot be sent,
  the composer says why: choose a model, or no model is available, with a link to
  Settings (#99).

## 1.1.3-rc.1 - 2026-11-15

First release candidate for 1.1.3, on the QA channel.

- Desktop uses Jouzu's own home (`%LOCALAPPDATA%\Shisa.ai\Jouzu\data`, or `JOUZU_HOME`
  when set) and no longer copies Jouzu's data into a folder of its own, so Desktop and `jz`
  in a terminal show the same sessions, settings and sign-ins (#90).
- Settings has a Web access page. It shows who can connect besides this window and lets
  you allow a browser on this computer, or devices on trusted networks such as your local
  network or Tailscale. Every browser must be paired with a one-time code, and paired
  devices can be removed at any time. Web access stays off until you turn it on (#91).
- A browser on another device opens the web UI over plain http instead of showing a blank
  page, and its copy buttons work (#106).
- The model list is built again after every settings change: models of an account you
  signed out of disappear, and providers added later appear (#84).
- The first start on a fresh install no longer stays on "Connecting to launcher…" after
  Node, the app and Git are installed (#87).
- The QA badge on the icon now comes with the QA package itself, installer included; the
  app no longer changes its icon when you switch the update channel (#74).
- QA releases are release candidates (`X.Y.Z-rc.N`). A stable release is built again from a
  candidate that passed QA, with the normal icon (#86).

## 1.1.2 - 2026-11-15

QA channel fixes.

- The first start after an update no longer stays on "Connecting to launcher…" when a new
  model catalog is activated while the last session opens (#73).
- Language settings can be saved again, in Settings and on the first-run language page (#72).
- A QA installation shows the Jouzu icon with a "QA" badge on the window, taskbar, tray and
  shortcuts, and switches back when you return to stable (#74).
- A turn's "files edited" list appears only under that turn of the session that made it, not
  under other sessions or earlier turns (#79).
- The README and public documentation describe the current design.

## 1.1.1 - 2026-11-15

QA channel fixes.

- A Shisa API key saved in Settings takes effect after "Refresh models", without restarting
  the app (#63).
- The image tool offers a provider only when it can generate images for your account; any
  other provider is listed with the reason it cannot be used (#64).
- The image tool lists every provider the model runtime has image models for, not only
  Shisa.AI, and generates through the runtime with them (#65).
- Settings has a Language page that shows and changes Jouzu's interface and reply language,
  shared with Jouzu in a terminal; first run asks for both before connecting a model (#66).
- Opening Settings → Tools before any tools settings were saved no longer blanks the
  window (#67).

## 1.1.0 - 2026-11-15

First release on the QA channel (Settings → System). It shares your data and sign-ins with
the stable channel, and you can switch back at any time.

- Chat sessions now run through a local host that keeps them alive on its own: closing or
  reloading the window no longer stops a reply, and a window that reconnects catches up.
- Startup keeps a few recent folders ready, so opening a session there does not wait for
  the model runtime to start.
- Messages sent while a reply is running wait in a visible queue and are delivered once, at
  the next step; Stop keeps them so you can continue or discard them.
- Saved conversations open on the model they last used.
- Session problems are shown in one place above the message box, with what to do next;
  there are no more floating notices.
- If the model runtime stops during a reply, the session recovers by itself and the
  unanswered message offers Retry. Flow control no longer shows "holding" after it has
  released.
- A missing bundled Node.js is reported instead of silently using another one.

## 1.0.23 - 2026-11-09

- Restore the session open path to the 2570a2d behaviour: a 4 MB tail preview
  read once, and an authoritative runtime transcript. The desktop-side pager,
  the 256 MB scan and the 20 MB native fallback are gone.
- A transcript above the 32 MiB frame limit is reported as a per-session error
  with a retry instead of dropping the session offline.
- The turn summary reports files created by shell commands, not only by edit
  tools, and renders them as cards instead of collapsing the whole turn.
- Settings blocks the view behind it while it is open.
- Workspace groups stay collapsed once the user collapses them.

## 1.0.11 - 2026-11-03

- Retry the model catalog after a fresh sign-in. The first catalog refresh can
  race a just-issued account key; the chat now retries it instead of leaving a
  signed-in install with an empty model list. If all attempts fail, the model
  menu and the Shisa.AI card in Settings offer an explicit retry.

## 1.0.10 - 2026-11-02

- Fix compact on a large session: the desktop no longer reads the whole
  transcript to attach for compact or after it, so a response above the 32 MiB
  JSONL frame limit can no longer close the session. Compaction changes the
  runtime context; the view keeps the transcript it already has.

## 1.0.9 - 2026-11-02

- Add Codex OAuth to Add Provider: sign in with a ChatGPT Plus/Pro account
  using the same device-code flow as Shisa.AI.

## 1.0.8 - 2026-11-02

- Fix the first-run runtime install: npm lifecycle scripts now find the Node
  that the installer just downloaded, so a machine without a system Node can
  finish provisioning.

## 1.0.1 - 2026-10-23

- Ship the desktop-only installer; the Jouzu runtime is provisioned separately.
- Update the app from the desktop update feed.
- Show the TextGuard review prompt above the composer.
- Add fork, pin and archive session actions.
- Reconcile interrupted tool calls when a session is reopened.

## 0.2.1 - 2026-10-21

- Prepare the standalone desktop product.
- Keep desktop identity independent from the launcher.

## 0.2.0 - 2026-10-20

- Add the Windows launcher with the embedded chat workspace.

