# UI layer: what the person sees and can do

Status: draft (2026-11-16), for discussion. Baseline: 1.1.3-rc.2. Part of a
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
  The reply ends with a failed marker and a short reason. The latest failed reply
  has Retry; earlier ones are just marked. The person can type and send as usual.
- **A message could not be sent.** The message stays in the conversation, dimmed,
  with Retry and Discard. Its text is never lost.

## 3. The composer

The composer shows what can be done now; it does not explain what cannot.

| Situation | Model button next to Send | Send | Other |
|---|---|---|---|
| New session, model still getting ready | Shows that it is loading | Unavailable | Typing works |
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
- A new session shows the model its runtime reports. Restoring the last selected
  model belongs to the runtime (runtime G1). Until it does, the UI remembers the
  last pick and selects it once the session is ready; that memory is never shown
  as the session's state.

## 5. Session header and sidebar

- **The window loses its connection to the host**: the header shows
  "Reconnecting…" and the composer is dimmed. The session keeps running in the
  host and the window catches up on reconnect. This is not a session error.
- The sidebar row shows whether a session is running or has ended; nothing else.

## 6. Settings

- **A settings action fails** (key rejected, sign-in failed): that card shows a
  short reason under the action that failed. Other cards keep working.
- **Several actions in a row**: each button shows its own progress while it waits
  its turn; nothing fails because another action is running.

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
| 5 | Model button and lists show only the session's models from the host | Sending right after creating a session no longer loses the message; Send is unavailable while the model is not ready |
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
