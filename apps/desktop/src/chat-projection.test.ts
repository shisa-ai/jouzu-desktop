import { describe, expect, it } from "vitest";
import { emptyProjection, historyProjection, historyRowsProjection, interruptUnfinishedTools, prependHistory, turnAt, type ChatMessage } from "./chat-projection";

describe("host history rows", () => {
  it("maps normalized blocks and tool rows into the existing projection", () => {
    const projection = historyRowsProjection([
      { kind: "user", text: "hello", createdAt: "2026-11-12T00:00:00.000Z", blocks: [{ type: "text", text: "hello" }] },
      { kind: "tool", id: "tool:call-1", tool: { name: "bash", callId: "call-1", status: "ok" }, args: { command: "ls" }, createdAt: "2026-11-12T00:00:01.000Z" },
      { kind: "assistant", text: "done", createdAt: "2026-11-12T00:00:02.000Z", blocks: [{ type: "thinking", text: "why" }, { type: "text", text: "done" }] },
    ]);
    expect(projection.messages[0].role).toBe("user");
    const assistant = projection.messages.find(message => message.role === "assistant");
    expect(assistant?.content[0]).toEqual({ type: "thinking", thinking: "why" });
    expect(projection.tools["call-1"]).toMatchObject({ name: "bash", phase: "complete", args: { command: "ls" } });
  });
});

describe("saved history projection", () => {
  it("marks a tool call without a result interrupted after settlement", () => {
    const history = historyProjection([{
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 600" } }],
      stopReason: "toolUse",
    }]);
    expect(history.tools["call-1"].phase).toBe("running");
    expect(interruptUnfinishedTools({ ...history, running: true }).tools["call-1"].phase).toBe("running");
    const settled = interruptUnfinishedTools({ ...history, running: false });
    expect(settled.tools["call-1"]).toMatchObject({ phase: "error", interrupted: true });
    expect(settled.tools["call-1"].result).toMatchObject({ content: [{ type: "text" }] });
  });
  it("reconstructs tool cards and task state from resumed history", () => {
    const state = historyProjection([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "TaskCreateMany", arguments: { tasks: [{ subject: "A" }] } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "TaskCreateMany", content: [{ type: "text", text: "Created 1 task:\n  #1 A" }], isError: false },
    ]);
    expect(state.tools.t1).toMatchObject({ name: "TaskCreateMany", phase: "complete", args: { tasks: [{ subject: "A" }] } });
    expect(state.tools.t1.result).toEqual({ content: [{ type: "text", text: "Created 1 task:\n  #1 A" }] });
  });
  it("accepts internal history entries without content", () => {
    const state = historyProjection([{ role: "compactionSummary", summary: "Older turns compacted" }]);
    expect(state.messages[0]).toMatchObject({ role: "compactionSummary", content: [] });
  });
  it("rejects invalid history", () => {
    expect(() => historyProjection({})).toThrow();
    expect(() => historyProjection([{ role: "assistant", content: 3 }])).toThrow();
  });
});

describe("host history with tool results", () => {
  it("shows a tool's result on its call, never as a block of its own", () => {
    const projection = historyRowsProjection([
      { kind: "user", id: "u", text: "list", blocks: [{ type: "text", text: "list" }] },
      { kind: "assistant", id: "a", text: "done", blocks: [
        { type: "toolCall", toolCallId: "call-1", name: "ls", input: {} },
        { type: "toolResult", toolCallId: "call-1", ok: true, result: { content: [{ type: "text", text: "a.txt" }] } },
        { type: "text", text: "done" },
      ] },
    ]);
    expect(projection.messages[1].content.map(block => block.type)).toEqual(["toolCall", "text"]);
    expect(projection.tools["call-1"]).toMatchObject({ name: "ls", phase: "complete", result: { content: [{ type: "text", text: "a.txt" }] } });
  });
});

describe("turns for branching (#20)", () => {
  const user = (turn?: number): ChatMessage => ({ role: "user", content: [], ...(turn ? { turn } : {}) });
  const reply = (turn?: number): ChatMessage => ({ role: "assistant", content: [], ...(turn ? { turn } : {}) });

  it("takes the turn the host numbered", () => {
    expect(turnAt([reply(41), user(42), reply(42)], 2, false)).toBe(42);
    // A page that starts inside a turn still knows it from its replies.
    expect(turnAt([reply(41)], 0, false)).toBe(41);
  });

  it("counts turns added live after the last numbered message", () => {
    expect(turnAt([user(7), reply(7), user(), reply(), user(), reply()], 5, false)).toBe(9);
  });

  it("counts from the start only when the whole conversation is loaded", () => {
    const live = [user(), reply(), user(), reply()];
    expect(turnAt(live, 3, true)).toBe(2);
    expect(turnAt(live, 3, false)).toBeUndefined();
  });

  it("does not take the index of a message as its turn", () => {
    // Tool results fold into replies, so message positions are not turns.
    const rows = historyRowsProjection([
      { kind: "user", text: "one", blocks: [{ type: "text", text: "one" }], turn: 1 },
      { kind: "assistant", blocks: [{ type: "toolCall", id: "c", name: "ls", arguments: {} }], turn: 1 },
      { kind: "assistant", text: "done", blocks: [{ type: "text", text: "done" }], turn: 1 },
      { kind: "user", text: "two", blocks: [{ type: "text", text: "two" }], turn: 2 },
      { kind: "assistant", text: "ok", blocks: [{ type: "text", text: "ok" }], turn: 2 },
    ]);
    expect(turnAt(rows.messages, 2, true)).toBe(1);
    expect(turnAt(rows.messages, 4, true)).toBe(2);
  });
});

describe("earlier history put in front", () => {
  it("moves the active message and the first index, and keeps the newer tool state", () => {
    const later = { ...emptyProjection(), messages: [{ role: "assistant", content: [] }], activeMessage: 0, tools: { c: { id: "c", name: "ls", args: undefined, phase: "complete" as const, result: "x" } } };
    const earlier = { ...emptyProjection(), messages: [{ role: "user", content: [] }, { role: "assistant", content: [] }], tools: { c: { id: "c", name: "ls", args: { path: "." }, phase: "running" as const } } };
    const merged = prependHistory(later, earlier);
    expect(merged.messages).toHaveLength(3);
    expect(merged.activeMessage).toBe(2);
    expect(merged.firstIndex).toBe(-2);
    expect(merged.tools.c).toMatchObject({ phase: "complete", result: "x", args: { path: "." } });
  });
});
