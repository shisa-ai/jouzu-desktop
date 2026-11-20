# UI layer: what the person sees and can do

Status: draft (2026-11-16; Settings cards 2026-11-20), for discussion. Baseline: 1.1.3-rc.2. Part of a
three-layer design: [runtime](runtime-layer.md), [host](host-layer.md) and
**UI** (this document).

This document is written from the person's point of view: what each screen shows
and what can be pressed. The UI uses the host's snapshots as data, but it is
designed from the person's view, not from the host's structure: one host field is
not one piece of screen.

## 1. Principles

- Something that cannot work is not offered. The person should rarely meet an
  error they could have been kept from.
- A control's own state carries most of the meaning; words are a short label or a
  tooltip. No explanatory paragraphs, no disclaimer-style copy.
- When something fails, it shows on the thing that failed, and nothing else stops
  working.
- Nothing moves when something appears or clears. Nothing the person typed is
  lost. No toasts, no pop-ups they did not ask for.
- Every action has a visible outcome.

## 2. The conversation

- **A tool call fails.** Its card shows the failed state (icon and colour) and,
  when opened, its output. Tool calls running beside it carry on, and so does the
  reply.
- **A reply fails** (the model provider stopped it, timed out, ran out of credit).
  The reply ends with a failed marker and a short reason, once, on the reply (the
  status line does not repeat it). The latest failed reply has what recovers it:
  Retry, or Sign in when the key was refused, Settings when the account is out of
  credit, Remove images when an image was refused; earlier ones are just marked.
  Until the runtime can rerun a reply (G12), Retry sends the message again, and a
  message with images gets no Retry. A request the runtime is still retrying is
  not a failed reply. The person can type and send as usual.
- **A message could not be sent.** The message stays in the conversation, dimmed,
  with Retry and Discard. Its text is never lost.

## 3. The composer

The composer shows what can be done now; it does not explain what cannot.

| Situation | Model button next to Send | Send | Other |
|---|---|---|---|
| New session, its runtime has not answered yet | Shows the model the host expects (the runtimes' earlier answer); a spinner only when nothing is known yet | Available: the host holds the message until the model is ready | Typing works |
| No model available | Becomes the way to set one up (opens Settings → Model providers) | Unavailable | Typing works |
| A reply is running | Normal | Adds the message to the queue above the composer (each item can be edited or removed until the runtime has it) | Stop is next to it |
| The model has no image input | — | — | The attach-image button is not shown |
| Commands that cannot run during a reply (compact, export) | — | — | Not offered while it runs |

**The session has ended because of an error** (its runtime failed and could not
be recovered, a refused image is stuck in its history, Flow history is full): the
composer is replaced by one line saying why and one button that recovers
(Restart session, Remove images, Clear Flow history). This is the only thing that
ever appears in the composer's place, and only one at a time.

## 4. Controls in the session

- **Changing the model fails**: the model button stays on the previous model and
  shows a small failed mark; its tooltip says why. Nothing else changes.
- **Stop, compact, export, a command fails**: the result shows at that control
  (the button's state, the command's own output line), not as a session message.
- A new session shows the model its runtime reports, and until then the model
  the host expects. Restoring the last selected model belongs to the runtime
  (runtime G1). Until it does, the UI remembers the last pick and sends it with
  the new conversation; the host hands it to the runtime before any message.
  The UI never switches the model of a session on its own.
- The model list is the host's: a new session shows the runtimes' latest list
  from its first frame. After a settings change it follows the change in open
  sessions too, without reopening them.

## 5. Session header and sidebar

- **The window loses its connection to the host**: the header shows
  "Reconnecting…" and the composer is dimmed. The session keeps running in the
  host and the window catches up on reconnect. This is not a session error.
- The sidebar row shows whether a session is running or has ended; nothing else.
- The session on screen is a host session. Opening a saved session from the
  sidebar opens it in the host at once (no runtime until a message needs one);
  its saved transcript may fill the screen meanwhile, but the composer never
  shows another session's model, run or Stop. A session the host stopped stays
  on screen as it is: its model shows, Send works, and the host starts it again
  for the message. The UI does not reopen sessions on its own.

## 6. Settings

- **A settings action fails** (key rejected, sign-in failed): that card shows a
  short reason under the action that failed. Other cards keep working.
- **Several actions in a row**: each button shows its own progress while it waits
  its turn; nothing fails because another action is running.

Each Settings card is drawn from one state. The card is designed for that state
as a whole; a host field is not a line of its own, and a fact appears once per
card. The tables below are the complete list of what each card shows.

### 6.1 Tools → Image generation

Image generation is one feature that depends on things in a chain: a connected
provider that can make images → a model of that provider → its sizes. Each level
exists only when the level above it has a value, so the card never shows a
level whose parent is empty ("No image provider available", then "No models",
then a size). Facts are not laid out side by side; the card shows the first
level that is missing and the one action that supplies it.

**Where availability comes from.** The providers that can make images are the
providers connected under Model providers, judged by the same credential the
chat uses. There is no second sign-in state for images: a provider that is
connected for chat is never "not signed in" for images (#96). A provider whose
account cannot make images (no image models, or a subscription without image
generation; whether Codex can is open in #170) is connected but not image-capable; that
is said once, by name, not as a sign-in problem.

**On means it works.** The feature is on only when the saved switch is on *and*
at least one provider can make images. When it is not on, the agent is not
offered `generate_image`: a tool that can only fail is not given to the agent,
and the person never meets "Image generation is disabled" or a credential error
in a conversation. The saved switch is never changed by the app; connecting a
provider later turns the feature on again without a visit to this page.

| State | The card shows | Not shown |
|---|---|---|
| Loading | Title and one waiting line | Any control |
| Image tool not installed | Title, the switch disabled and off, one line: "The image tool is not installed yet." | Everything below the switch |
| No connected provider can make images | Title, the switch disabled and off, one line naming what is missing and **Model providers**. For example "Connect Shisa.AI or OpenRouter to generate images." or, when other providers are connected, "My provider cannot generate images. Connect Shisa.AI or OpenRouter." Per-provider reasons are under Details, not on the page | Provider, model, size, images per call; any per-provider list |
| Can make images, switch off | Title and the switch, off | Everything below the switch |
| Can make images, switch on | The switch, then: provider (a select only when more than one provider can make images, otherwise its name as text), the model of that provider, size (only when the provider takes one), images per call | Providers that cannot make images; empty-select texts ("No models") |
| Saving or a provider's model list fails | The failed level shows a short reason under it; the levels above keep working | — |

### 6.2 System → Jouzu Desktop

This is one row: the product the person installed. The runtime is part of it,
not a second product.

- **Always**: "Jouzu Desktop", the version, and one state on the right. Under the
  version, one quiet detail line: "Runtime 0.2.5". The commit and build stamp are
  a tooltip on the version, not a line.
- **The runtime has no update row and no update text.** Desktop installs the
  runtime at a pinned version ([0003](../decisions/0003-no-bundled-runtime.md));
  a new runtime arrives with a new Desktop release. The separate runtime updater
  (`jouzu-update.json`) is only configured by the removed Launcher packaging, so
  its row and hook are removed with #168. When the runtime files are missing
  or do not start, the detail line says so and the row's one action is
  **Repair**.

| Desktop state | Right side | Under the version | Sidebar update mark |
|---|---|---|---|
| Checking | Spinner, "Checking…" | — | No change |
| Up to date | "Up to date" | Channel select | No |
| A newer version on this channel | **Update and restart** (primary) and "Update available" tag | "What's new" for the new version; channel select | Yes |
| This build is newer than the channel's latest (a QA build on Stable) | "This is a test build" | A plain button "Install Stable 1.0.23 (older)", whose confirmation says it installs an older version; channel select. No "What's new" | No |
| Downloading / installing | Progress | — | Yes |
| Check or install failed | One reason line with Details, and Retry | Channel select | No |
| Online updates not configured (development build) | Nothing | — | No |

### 6.3 System → components (Git Bash, terminal, command entry)

Each component row shows one state: checking, in use (which copy and its
version), missing, or broken. The action slot keeps its size so nothing moves,
but it shows a button only when an action applies: **Install** when missing,
**Repair** when broken. While checking, and while a copy is in use, the slot is
empty. A disabled button for an action that does not apply is not shown.

## 7. Start page and MCP

- **The app cannot work** (host unreachable, runtime not installed): the start
  page says so in one line with the one action that fixes it.
- **An MCP server needs attention** (for example sign-in): its entry in the MCP
  menu shows the state and the action. It is not shown in the conversation and is
  not repeated each time a runtime starts.

## 8. Words and layout

- One short line at most. If a state needs more than a line to explain, the
  layout is changed instead.
- Original technical text is available under Details where it helps (copyable,
  never translated), and never as the main sentence. Advice that only works in a
  terminal ("Run /mcp") is never shown.
- Every label and line exists in en, ja, zh-Hans and zh-Hant, localized from the
  host's error code and parameters.
- Fixed sizes: showing or clearing any of the above never moves the composer, the
  conversation or the sidebar, and long tokens (paths, model ids) never widen the
  window.

## 9. State the UI owns

Only local state unrelated to the host: composer drafts, expanded/collapsed
sections, scroll position, connection state, which panel is open. Everything
else comes from host snapshots.

## 10. UI code to remove

- The four model copies (catalog list fetched once, per-session list, stored
  preference, the Settings list) and the one-second wait for a default model.
- Inferring busy state locally.
- Reopening a stopped session from the UI (`reopenBoundSession` on `stopped`).
- The local steer queue.
- Partial queuing of configuration operations and handling of `409`.
- The notice list in `session-alerts` built from about 14 inputs, and the code
  that parses runtime text.
- Hard-coded English strings.

## 11. UI steps

Each step follows the matching host step and is verified on the packaged QA
build before the next.

| Step | Change | Acceptance |
|---|---|---|
| 3 | Session state: render `run` and `queue` only; remove local inference | A send during a Flow run goes to the queue; after Stop the queue is correct |
| 5 | Model button and lists show only the models the host relays | A new session: the model is shown and Send is usable the moment the composer shows (0 s); the first message goes out on the picked model; Refresh models or a provider change updates the list of an open session |
| 7 | Each settings card shows its own progress and result | Several actions in a row all complete; a failed save shows only on its card |
| 9 | Errors shown where they belong, in four languages | One of two parallel tool calls fails: only its card shows it; model change fails: only the model button changes; session ends: composer replaced by reason and one action; longest text and a long token at the smallest window: nothing moves or widens; no toast component exists |

## 12. Known gaps in the current build (1.1.3-rc.2)

- Fixed by step 9: errors no longer collect above the composer. Until the
  runtime reports them as structure (G6), a refused image, a full Flow history
  or exhausted quota is recognized from the runtime's text, and only adds its
  recovery action to the reply or message that failed.
- Send is available before a new session has a model, so a message can vanish.
- One settings action running makes the others fail with "Another configuration
  operation is running".
- MCP status repeats on every runtime start, with terminal advice.
- Parts of the chat (labels, menus, run status words) are still English only;
  every error and recovery text is in the four interface languages.
