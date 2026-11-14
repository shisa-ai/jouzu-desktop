import { describe, expect, it } from "vitest";
import { emptyProjection, historyProjection, historyRowsProjection, interruptUnfinishedTools, projectEvent } from "./chat-projection";

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

describe("released runtime event projection", () => {
  it("resets populated start blocks before applying released wire deltas", () => {
    let state = projectEvent(emptyProjection(), { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "fast response" }], stopReason: "pending" } });
    state = projectEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    state = projectEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "fast response" } });
    expect(state.messages[0].content[0].text).toBe("fast response");
  });
  it("waits for agent_settled rather than low-level agent_end", () => {
    let state = projectEvent(emptyProjection(), { type: "agent_start" });
    state = projectEvent(state, { type: "agent_end", willRetry: false });
    expect(state.running).toBe(true);
    expect(projectEvent(state, { type: "agent_settled" }).running).toBe(false);
  });
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
  it("streams thinking deltas into the visible active message", () => {
    let state = projectEvent(emptyProjection(), { type: "agent_start" });
    expect(state.turnStartedAt).toBeTypeOf("number");
    state = projectEvent(state, { type: "message_start", message: { role: "assistant", content: [] } });
    for (const update of [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "considering " },
      { type: "thinking_delta", contentIndex: 0, delta: "the options" },
    ]) state = projectEvent(state, { type: "message_update", assistantMessageEvent: update });
    expect(state.messages[0].content[0]).toMatchObject({ type: "thinking", thinking: "considering the options" });
    expect(state.running).toBe(true);
    expect(projectEvent(state, { type: "agent_settled" })).toMatchObject({ running: false, turnStartedAt: undefined });
  });
  it("reconstructs deltas and replaces them with authoritative final content", () => {
    let state = projectEvent(emptyProjection(), { type: "message_start", message: { role: "assistant", content: [] } });
    for (const update of [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "draft" },
      { type: "text_end", contentIndex: 0, content: "final block" },
    ]) state = projectEvent(state, { type: "message_update", assistantMessageEvent: update });
    expect(state.messages[0].content[0].text).toBe("final block");
    state = projectEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "authoritative" }] } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content[0].text).toBe("authoritative");
  });
  it("does not duplicate user start/end or invent optimistic history", () => {
    let state = emptyProjection();
    const message = { role: "user", content: "hello" };
    state = projectEvent(state, { type: "message_start", message });
    state = projectEvent(state, { type: "message_end", message });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "hello" }] });
  });
  it("keeps displayed Jouzu flow reports as structured session activity", () => {
    const state = projectEvent(emptyProjection(), {
      type: "custom_message",
      customType: "jouzu-flow",
      display: true,
      timestamp: 123,
      content: [{ type: "text", text: JSON.stringify({ kind: "work", content: "Continue task #1" }) }],
    });
    expect(state.flowReports).toEqual([{ kind: "work", text: JSON.stringify({ kind: "work", content: "Continue task #1" }), timestamp: 123 }]);
    const appended = projectEvent(emptyProjection(), { type: "entry_appended", entry: { type: "custom_message", customType: "jouzu-flow", display: true, timestamp: 456, content: [{ type: "text", text: JSON.stringify({ kind: "alert", content: "Paused" }) }] } });
    expect(appended.flowReports).toEqual([{ kind: "alert", text: JSON.stringify({ kind: "alert", content: "Paused" }), timestamp: 456 }]);
    expect(projectEvent(state, { type: "custom_message", customType: "other", content: [] }).flowReports).toHaveLength(1);
  });
  it("reconstructs tool cards and task state from resumed history", () => {
    const state = historyProjection([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "TaskCreateMany", arguments: { tasks: [{ subject: "A" }] } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "TaskCreateMany", content: [{ type: "text", text: "Created 1 task:\n  #1 A" }], isError: false },
    ]);
    expect(state.tools.t1).toMatchObject({ name: "TaskCreateMany", phase: "complete", args: { tasks: [{ subject: "A" }] } });
    expect(state.tools.t1.result).toEqual({ content: [{ type: "text", text: "Created 1 task:\n  #1 A" }] });
  });
  it("correlates tool lifecycle without promoting partial output to completion", () => {    let state = projectEvent(emptyProjection(), { type: "agent_start" });
    state = projectEvent(state, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "file" } });
    state = projectEvent(state, { type: "tool_execution_update", toolCallId: "a", toolName: "read", partialResult: { content: [] } });
    expect(state.tools.a.phase).toBe("running");
    state = projectEvent(state, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "done" }] }, isError: true });
    expect(state.tools.a.phase).toBe("error");
    expect(state.tools.a.args).toEqual({ path: "file" });
  });
  it("recovers a tool update whose start was emitted before a resumed history", () => {
    let state = projectEvent({ ...emptyProjection(), running: true }, { type: "tool_execution_update", toolCallId: "late", toolName: "bash", partialResult: { content: [] } });
    expect(state.tools.late).toMatchObject({ name: "bash", phase: "running" });
    state = projectEvent(state, { type: "tool_execution_end", toolCallId: "late", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false });
    expect(state.tools.late).toMatchObject({ phase: "complete", result: { content: [{ type: "text", text: "done" }] } });
  });
  it("marks a tool event received after the agent settled as interrupted", () => {
    const state = projectEvent(emptyProjection(), { type: "tool_execution_start", toolCallId: "stale", toolName: "bash", args: { command: "sleep 600" } });
    expect(state.tools.stale).toMatchObject({ phase: "error", interrupted: true });
  });
  it("retains unknown event names without inferring outcomes", () => {
    const state = projectEvent({ ...emptyProjection(), running: true }, { type: "future_event", text: "completed successfully" });
    expect(state.running).toBe(true);
    expect(state.compatibility).toEqual(["future_event"]);
  });
  it("accepts internal history entries without content", () => {
    const state = historyProjection([{ role: "compactionSummary", summary: "Older turns compacted" }]);
    expect(state.messages[0]).toMatchObject({ role: "compactionSummary", content: [] });
  });
  it("rejects invalid history, orphan deltas and unbounded sparse indices", () => {
    expect(() => historyProjection({})).toThrow();
    expect(() => historyProjection([{ role: "assistant", content: 3 }])).toThrow();
    expect(() => projectEvent(emptyProjection(), { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "orphan" } })).toThrow();
    const state = projectEvent(emptyProjection(), { type: "message_start", message: { role: "assistant", content: [] } });
    expect(() => projectEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1000000 } })).toThrow();
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
