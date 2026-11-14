import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatConversation } from "./chat-conversation";
import { turnLabel } from "./chat-live";
import type { TurnStep } from "./chat-types";
import { emptyProjection, type ChatProjection } from "./chat-projection";

const running = (last: "thinking" | "toolCall"): ChatProjection => ({
  ...emptyProjection(),
  running: true,
  activeMessage: 1,
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first step" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        ...(last === "thinking" ? [{ type: "thinking", thinking: "now writing" }] : [{ type: "thinking", thinking: "second step" }, { type: "toolCall", id: "t2", name: "bash", arguments: {} }]),
      ],
    },
  ],
  tools: { t1: { id: "t1", name: "bash", args: {}, phase: "complete" } },
});
const reasoning = (html: string) => (html.match(/aria-label="Thinking · done"/g) ?? []).length;

describe("a long turn", () => {
  it("keeps each finished step's reasoning while the turn runs", () => {
    expect(reasoning(renderToStaticMarkup(<ChatConversation projection={running("toolCall")} />))).toBe(2);
  });

  it("leaves the reasoning the status line shows out of the reply", () => {
    expect(reasoning(renderToStaticMarkup(<ChatConversation projection={running("thinking")} reasoningLive />))).toBe(1);
    expect(reasoning(renderToStaticMarkup(<ChatConversation projection={running("thinking")} />))).toBe(2);
  });
});

describe("the turn status line", () => {
  const turn = (step: TurnStep | undefined, phase = "running") => ({ turnId: "m-1", phase, step });
  const now = Date.parse("2026-11-14T00:01:00Z");
  const since = Date.parse("2026-11-14T00:00:19Z");
  it("says the model has not answered yet, and for how long", () => {
    expect(turnLabel(turn({ n: 1, state: "waiting_model", since, tools: [] }), now)).toBe("Waiting for model · 0:41");
    expect(turnLabel(turn({ n: 6, state: "waiting_model", since, tools: [] }), now)).toBe("Waiting for model · 0:41");
  });
  it("does not repeat the turn's own clock when the state began with the turn", () => {
    expect(turnLabel({ ...turn({ n: 1, state: "waiting_model", since, tools: [] }), startedAt: since }, now)).toBe("Waiting for model");
    expect(turnLabel({ ...turn({ n: 2, state: "waiting_model", since, tools: [] }), startedAt: since - 5000 }, now)).toBe("Waiting for model · 0:41");
  });
  it("names the tools at work", () => {
    expect(turnLabel(turn({ n: 2, state: "tools", since, tools: [{ id: "a", name: "write" }, { id: "b", name: "write" }] }), now)).toBe("Running write · 0:41");
  });
  it("says a failed model request is being retried", () => {
    expect(turnLabel(turn({ n: 1, state: "retrying", tools: [], retry: { attempt: 2, maxAttempts: 3, error: "overloaded" } }), now)).toBe("Model request failed, retrying 2/3 (overloaded)");
  });
  it("keeps the session's own phase first", () => {
    expect(turnLabel(turn(undefined, "starting"), now)).toBe("Starting session…");
    expect(turnLabel(turn({ n: 1, state: "writing", tools: [] }, "cancelling"), now)).toBe("Stopping…");
  });
});
