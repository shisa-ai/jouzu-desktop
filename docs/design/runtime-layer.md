# Runtime layer: what the desktop relies on from jouzu

Status: draft (2026-11-16), for discussion. Part of a three-layer design:
**runtime** (this document), [host](host-layer.md) and [UI](ui-layer.md). Each
layer has its own document and its own readers; none repeats another.

This document covers only what the jouzu runtime provides, which of its
behaviours the host relies on, and what we need changed in the runtime. The
runtime talks only to the host and knows nothing about any UI. Behaviours below
were checked against the published jouzu 0.2.6 package.

## Boundary

- One runtime process per session, talking to the host over stdio RPC.
  Configuration, sign-in and the model catalog go through the runtime's control
  channel.
- The host uses the runtime through an adapter. Supporting another runtime built
  on the same kernel means replacing the adapter, nothing else.
- Runtime events and runtime text reach the host only. The runtime's state is the
  source of truth; the host does not guess it.

## Behaviours the host relies on

| Topic | jouzu 0.2.6 behaviour | How the host uses it |
|---|---|---|
| A run | Starts with `agent_start`, ends with `agent_settled`; in between `turn_*`, `message_*`, `tool_execution_*`, `auto_retry_*`, `compaction_*` | A run starts and ends on these two events only, whoever started it |
| Runs started by the runtime | Flow and extensions can start a run with no prompt from the host | The host records it as a run with `origin = runtime` |
| Input during a run | While streaming, input must carry `steer` or `followUp`; a plain prompt is refused ("Agent is already processing"). Such input is not accepted during retry or compaction. Queued steers are dropped when the run is aborted. Flow's automated sends wait until user input has been handled | The host chooses prompt or steer from the streaming state; during retry/compaction the message stays in the host queue; dropped steers return to the queue |
| Answering a prompt | The answer to `prompt` comes after the extensions' input handlers: refused, `handled` (used without a run), or `started`, written just before that run's `agent_start` | A run that starts before the host's prompt was answered is the runtime's own; the prompt waits in the host queue for its answer |
| Choosing a model | RPC `set_model` changes only that session (recorded in the session file); making it the global default is the caller's choice | When the person picks a model in a session, the host also writes it as the runtime's default model, so new sessions use the last selected model |
| Model catalog | Control `available-models` returns the list and the default model; the catalog has a revision, and Shisa provider ids carry it; a runtime reads the catalog only at start | The host records which revision each runtime loaded and recycles runtimes when the revision changes |
| Configuration channel | One configuration operation at a time | The host queues operations |
| Input length | No length cap on user prompts; a 32 KiB cap applies only to external and Flow-composed input; fitting the model's context window is checked by the runtime | The host adds no length limit of its own |
| Notifications | Extensions send text through `notify` (for example MCP "needs sign-in, Run /mcp"), once per runtime start | The host deduplicates per session and routes it to the feature it belongs to |
| Errors | Provider errors, refused images and quota are text only, with no structured code | The host can only classify by text for now (see the request below) |

## What we need changed in the runtime

None of these is fixed in the desktop.

| Problem | State |
|---|---|
| An image refused by the provider is resent every turn | Filed: jouzu#54 |
| Concurrent starts race for `profile.lock`; the loser exits with code 1 | Filed: jouzu#55 |
| A session file is written before any conversation | Filed: jouzu#56 |
| TextGuard / Flow: messages under RPC, read-only state, structured Flow state, recovery hints, abort while input is handled, cache the agent can modify | Filed: jouzu#57–#62 |
| Choosing Simplified Chinese falls back to English (locale not reviewed) | Not filed; to be confirmed |
| Structured codes for provider errors (quota, refused image, authentication), not only text | Not filed; proposed. Until then the host's text classification is a stopgap |
| Whether Flow still starts runs on its own after Stop | Part of the Flow design; waits on jouzu#57–#62 |

## Constraints on the runtime integration

- Only a person approves, releases or recovers. The host passes on the person's
  action and never decides for them; the agent must never be able to approve its
  own held work.
- The desktop does not work around runtime behaviour. A capability the runtime
  does not provide gets an issue first, not a workaround.
