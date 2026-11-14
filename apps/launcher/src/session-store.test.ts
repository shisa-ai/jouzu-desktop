import { describe, expect, it, vi } from "vitest";
import { SessionStore, type SessionPort } from "./session-store";
import type { ApiEvent, HistoryPage } from "./api/jouzu-api";

function fakeSession(): SessionPort & { emit: (event: ApiEvent) => void; sent: unknown[]; stopped: boolean } {
  let listener: ((event: ApiEvent) => void) | undefined;
  const sent: unknown[] = [];
  const session = {
    id: "s-test",
    sent,
    stopped: false,
    history: async (): Promise<HistoryPage> => ({
      messages: [
        { cursor: 1, id: "u1", kind: "user", text: "hello", createdAt: "2026-11-12T00:00:00.000Z", blocks: [{ type: "text", text: "hello" }] },
      ],
      nextBefore: null,
    }) as unknown as HistoryPage,
    send: async (message: unknown) => {
      sent.push(message);
      return { messageId: "m-1", receipt: "queued" };
    },
    interrupt: async () => {},
    cancel: async () => {},
    queue: async () => {},
    stop: async () => { session.stopped = true; },
    detach: () => { listener = undefined; },
    follow: (onEvent: (event: ApiEvent) => void) => { listener = onEvent; },
    emit: (event: ApiEvent) => listener?.(event),
  };
  return session;
}

const event = (id: number, name: string, data: Record<string, unknown>): ApiEvent => ({ id, event: name, data: { ...data, sessionId: "s-test" } });

describe("SessionStore", () => {
  it("loads host history and projects normalized blocks", async () => {
    const store = SessionStore.attach(fakeSession());
    await store.loadHistory();
    expect(store.snapshot.connected).toBe(true);
    expect(store.snapshot.projection.messages[0].content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("follows message and tool events without raw runtime records", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.delta", { messageId: "m-1", text: "hi" }));
    session.emit(event(3, "message.delta", { messageId: "m-1", text: "!", kind: "thinking" }));
    session.emit(event(4, "tool.start", { toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }));
    session.emit(event(5, "tool.result", { toolCallId: "call-1", ok: true, result: { output: "x" } }));
    session.emit(event(6, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "hi" }], stopReason: "completed" }));

    const projection = store.snapshot.projection;
    expect(projection.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
    expect(projection.tools["call-1"]).toMatchObject({ phase: "complete", name: "bash" });
    expect(projection.running).toBe(false);
  });

  it("shows a send in the outbox until the host confirms it", async () => {
    let release: () => void = () => {};
    const session = fakeSession();
    const send = session.send;
    session.send = async message => { await new Promise<void>(resolve => { release = resolve; }); return send(message); };
    const store = SessionStore.attach(session);
    const pending = store.send("hello", [], "client-1");
    expect(store.snapshot.pending).toBe(true);
    expect(store.snapshot.outbox).toMatchObject([{ clientMessageId: "client-1", text: "hello", state: "sending" }]);
    release();
    await pending;
    expect(session.sent).toEqual([{ clientMessageId: "client-1", text: "hello", attachments: [] }]);
    expect(store.snapshot.pending).toBe(false);
    expect(store.snapshot.outbox).toEqual([]);
    expect(store.snapshot.projection.messages.map(message => `${message.role}:${message.turnId}`)).toEqual(["user:m-1"]);
  });

  it("puts the message back when Stop does not reach the host", async () => {
    let release: () => void = () => {};
    const session = fakeSession();
    const send = session.send;
    session.send = async message => { await new Promise<void>(resolve => { release = resolve; }); return send(message); };
    session.cancel = async () => { throw new Error("host unreachable"); };
    const store = SessionStore.attach(session);
    const pending = store.send("hello", [], "client-1");
    await store.stop();
    expect(store.snapshot.outbox).toMatchObject([{ clientMessageId: "client-1", text: "hello", state: "sending" }]);
    expect(store.snapshot.error).toContain("host unreachable");
    release();
    await pending;
    expect(store.snapshot.outbox).toEqual([]);
  });

  it("keeps a failed send as not sent, and retries it with the same id", async () => {
    const session = fakeSession();
    const send = session.send;
    let fail = true;
    session.send = async message => { if (fail) throw new Error("network down"); return send(message); };
    const store = SessionStore.attach(session);
    await expect(store.send("hello", [], "client-1")).rejects.toThrow();
    expect(store.snapshot.outbox).toMatchObject([{ clientMessageId: "client-1", state: "failed" }]);
    expect(store.snapshot.pending).toBe(false);
    fail = false;
    await store.retry("client-1");
    expect(session.sent).toEqual([{ clientMessageId: "client-1", text: "hello", attachments: [] }]);
    expect(store.snapshot.outbox).toEqual([]);
  });

  it("takes running and its start time only from the host summary", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.updated", { activeTurn: { turnId: "m-1", phase: "running", startedAt: "2026-11-13T00:00:00.000Z" } }));
    expect(store.snapshot.projection.running).toBe(true);
    expect(store.snapshot.projection.turnStartedAt).toBe(Date.parse("2026-11-13T00:00:00.000Z"));
    session.emit(event(2, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "hi" }], stopReason: "completed" }));
    expect(store.snapshot.projection.running).toBe(true);
    session.emit(event(3, "session.updated", { activeTurn: null }));
    expect(store.snapshot.projection.running).toBe(false);
  });

  it("shows the model the host reports for the session", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.updated", { model: { provider: "shisa", id: "qwen-3.8", name: "Qwen 3.8" } }));
    expect(store.snapshot.model).toBe("Qwen 3.8");
    expect(store.snapshot.modelProvider).toBe("shisa");
    expect(store.snapshot.modelId).toBe("qwen-3.8");
    session.emit(event(2, "session.updated", { model: null }));
    expect(store.snapshot.modelId).toBe("qwen-3.8");
  });

  it("shows a tool call in the live reply as soon as it starts", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.updated", { activeTurn: { turnId: "m-1", phase: "running" } }));
    session.emit(event(2, "tool.start", { toolCallId: "call-1", toolName: "bash", args: { command: "ls" } }));
    const last = store.snapshot.projection.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call-1", name: "bash" }));
  });

  it("keeps each step of a run as its own reply, with its tool on it", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.updated", { activeTurn: { turnId: "m-1", phase: "running", step: { n: 1, state: "thinking", tools: [] } } }));
    session.emit(event(2, "message.start", { messageId: "m-1", turnId: "m-1", step: 1, role: "assistant" }));
    session.emit(event(3, "message.delta", { messageId: "m-1", text: "plan", kind: "thinking" }));
    session.emit(event(4, "message.done", { messageId: "m-1", step: 1, stopReason: "toolUse", blocks: [{ type: "thinking", text: "plan" }, { type: "toolCall", toolCallId: "call-1", name: "bash", input: {} }] }));
    session.emit(event(5, "tool.start", { toolCallId: "call-1", toolName: "bash", args: {}, step: 1 }));
    session.emit(event(6, "tool.result", { toolCallId: "call-1", ok: true, result: { output: "x" } }));
    session.emit(event(7, "message.start", { messageId: "m-1", turnId: "m-1", step: 2, role: "assistant" }));
    session.emit(event(8, "message.delta", { messageId: "m-1", text: "check", kind: "thinking" }));
    const replies = store.snapshot.projection.messages.filter(message => message.role === "assistant");
    expect(replies).toHaveLength(2);
    expect(replies[0].content).toEqual([{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "call-1", name: "bash", arguments: {} }]);
    expect(replies[1].content).toEqual([{ type: "thinking", thinking: "check" }]);
    expect(store.snapshot.projection.tools["call-1"]).toMatchObject({ phase: "complete" });
    expect(store.snapshot.activeTurn?.step).toMatchObject({ n: 1, state: "thinking" });
  });

  it("shows a tool the host closed as interrupted, not running", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "tool.start", { toolCallId: "call-2", toolName: "bash", args: {} }));
    session.emit(event(2, "tool.result", { toolCallId: "call-2", ok: false, interrupted: true, result: { content: [{ type: "text", text: "Interrupted" }] } }));
    expect(store.snapshot.projection.tools["call-2"]).toMatchObject({ phase: "error", interrupted: true });
  });

  it("adds a Flow report the runtime shows as it arrives", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "message.custom", { customType: "jouzu-flow-report", display: true, text: JSON.stringify({ kind: "budget", note: "x" }) }));
    session.emit(event(2, "message.custom", { customType: "jouzu-flow-report", display: false, text: JSON.stringify({ kind: "hidden" }) }));
    session.emit(event(3, "message.custom", { customType: "other", text: JSON.stringify({ kind: "nope" }) }));
    expect(store.snapshot.projection.flowReports.map(report => report.kind)).toEqual(["budget"]);
  });

  it("answers a prompt with the host's exact option and keeps the card when that fails", async () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    const approve = vi.fn(async () => { throw Object.assign(new Error("forbidden"), { code: "prompt-forbidden" }); });
    (store as unknown as { api: unknown }).api = { prompts: { approve, answer: vi.fn() } };
    session.emit(event(1, "approval.requested", { approvalId: "a-1", tool: "Allow?", args: { title: "Allow?", message: "Run it" }, options: ["Approve", "Deny"] }));
    const prompt = store.snapshot.prompts![0]!;
    expect(prompt.options).toEqual(["Approve", "Deny"]);
    await expect(store.answer(prompt, "Approve")).rejects.toThrow();
    expect(approve).toHaveBeenCalledWith("a-1", "Approve");
    expect(store.snapshot.prompts).toHaveLength(1);
    approve.mockImplementation(async () => undefined as never);
    await store.answer(prompt, "Approve");
    expect(store.snapshot.prompts).toHaveLength(0);
  });

  it("hydrates pending prompts from the host summary", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.updated", { pendingApprovals: [{ approvalId: "a-2", tool: "Allow?", args: { title: "Allow?", message: "" }, options: ["Approve", "Deny"] }], pendingQuestions: [] }));
    expect(store.snapshot.prompts?.map(item => item.id)).toEqual(["a-2"]);
    session.emit(event(2, "approval.resolved", { approvalId: "a-2" }));
    expect(store.snapshot.prompts).toEqual([]);
  });

  it("routes runtime notices to TextGuard, Flow, or the toast", () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.notice", { message: "TextGuard now withholds every flagged input until you approve it with /textguard.", level: "info" }));
    expect(store.snapshot.textguard?.mode).toBe("strict");
    session.emit(event(2, "session.notice", { message: "Flow control is holding your message: budget. Run /flow for the control that releases it.", level: "info" }));
    expect(store.snapshot.flowHold).toEqual({ text: "Flow control is holding your message: budget.", paused: false });
    session.emit(event(3, "session.notice", { message: "Cleared flow reservation r-1.", level: "info" }));
    expect(store.snapshot.notice).toMatchObject({ text: "Cleared flow reservation r-1." });
    session.emit(event(4, "session.updated", { statuses: { flow: "held 1" }, widgets: { flow: ["a"], empty: [] } }));
    expect(store.snapshot.statuses).toEqual({ flow: "held 1" });
    expect(store.snapshot.widgets).toEqual({ flow: ["a"] });
  });

  it("releases a Flow hold through /flow and ends the banner", async () => {
    const session = fakeSession();
    const store = SessionStore.attach(session);
    session.emit(event(1, "session.notice", { message: "Flow control is holding your message: budget. Run /flow for the control that releases it." }));
    await store.flow("clear");
    expect(session.sent).toMatchObject([{ text: "/flow clear" }]);
    expect(store.snapshot.flowHold).toBeNull();
    await store.setTextGuardMode("off");
    expect(session.sent).toMatchObject([{ text: "/flow clear" }, { text: "/textguard off" }]);
  });

  it("keeps a reply with its own turn when a follow-up was accepted first", async () => {
    const session = fakeSession();
    let next = 0;
    session.send = async message => { session.sent.push(message); next += 1; return { messageId: `m-${next}`, receipt: "queued" }; };
    const store = SessionStore.attach(session);
    await store.send("one", [], "c-1");
    await store.send("two", [], "c-2");
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "a1" }], stopReason: "completed" }));
    session.emit(event(3, "message.start", { messageId: "m-2", turnId: "m-2", role: "assistant" }));
    session.emit(event(4, "message.done", { messageId: "m-2", blocks: [{ type: "text", text: "a2" }], stopReason: "completed" }));
    expect(store.snapshot.projection.messages.map(message => `${message.role}:${message.turnId}`)).toEqual(["user:m-1", "assistant:m-1", "user:m-2", "assistant:m-2"]);
  });

  it("puts the accepted user row before a reply that started first", async () => {
    let release: () => void = () => {};
    const session = fakeSession();
    const send = session.send;
    session.send = async message => { await new Promise<void>(resolve => { release = resolve; }); return send(message); };
    const store = SessionStore.attach(session);
    const pending = store.send("hello", [], "client-1");
    await new Promise(resolve => setTimeout(resolve, 2));
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.delta", { messageId: "m-1", text: "hi" }));
    release();
    await pending;
    session.emit(event(3, "message.delta", { messageId: "m-1", text: "!" }));
    const messages = store.snapshot.projection.messages;
    expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toEqual([{ type: "text", text: "hi!" }]);
  });

  it("keeps a message sent during a run out of the conversation until the runtime uses it", async () => {
    const session = fakeSession();
    session.send = async message => { session.sent.push(message); return { messageId: "m-2", receipt: "queued", waiting: true }; };
    const store = SessionStore.attach(session);
    session.emit(event(1, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(2, "message.done", { messageId: "m-1", blocks: [{ type: "text", text: "step 1" }], stopReason: "toolUse" }));
    const image = { type: "image" as const, data: "AAEC", mimeType: "image/png" as const };
    await store.send("also check the tests", [image], "c-2");
    session.emit(event(3, "session.updated", { queue: [{ clientMessageId: "c-2", text: "also check the tests", state: "queued", images: 1, turnId: "m-2" }] }));
    expect(store.snapshot.outbox).toEqual([]);
    expect(store.snapshot.projection.messages.map(message => message.role)).toEqual(["assistant"]);
    expect(store.snapshot.queue).toEqual([{ clientMessageId: "c-2", text: "also check the tests", state: "queued", images: 1 }]);
    // Delivered between steps: one row, where it happened, with its image.
    session.emit(event(4, "message.user", { kind: "user", id: "m-2:user", turnId: "m-1", clientMessageId: "c-2", text: "also check the tests", blocks: [{ type: "text", text: "also check the tests" }] }));
    session.emit(event(5, "session.updated", { queue: [] }));
    session.emit(event(6, "message.start", { messageId: "m-1", turnId: "m-1", role: "assistant" }));
    session.emit(event(7, "message.delta", { messageId: "m-1", turnId: "m-1", text: "ok" }));
    const messages = store.snapshot.projection.messages;
    expect(messages.map(message => message.role)).toEqual(["assistant", "user", "assistant"]);
    expect(messages[1].content).toEqual([{ type: "text", text: "also check the tests" }, image]);
    expect(store.snapshot.queue).toEqual([]);
  });

  it("gives a waiting message back for editing and removes it from the queue", async () => {
    const session = fakeSession();
    const cancelled: string[] = [];
    session.cancel = async id => { cancelled.push(id); };
    session.send = async message => { session.sent.push(message); return { messageId: "m-2", receipt: "queued", waiting: true }; };
    const store = SessionStore.attach(session);
    const image = { type: "image" as const, data: "AAEC", mimeType: "image/png" as const };
    await store.send("draft", [image], "c-2");
    session.emit(event(1, "session.updated", { queue: [{ clientMessageId: "c-2", text: "draft", state: "queued", images: 1 }] }));
    expect(await store.takeQueued("c-2")).toEqual({ text: "draft", images: [image] });
    expect(cancelled).toEqual(["c-2"]);
  });

  it("disposes exactly once", () => {
    const onDispose = vi.fn();
    const store = SessionStore.attach(fakeSession(), onDispose);
    store.dispose();
    store.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });
});
