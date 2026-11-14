// Presentation-only projection of the released JSONL event contract.
// Agent history and completion remain authoritative in the runtime.
export type WireObject = Record<string, unknown>;
export interface ChatBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string; content?: ChatBlock[]; toolCallId?: string; isError?: boolean }
export interface ChatMessage { role: string; content: ChatBlock[]; turnId?: string; details?: unknown; timestamp?: number; endedAt?: number; stopReason?: string; errorMessage?: string; toolCallId?: string; toolName?: string; isError?: boolean; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; totalTokens?: number } }
export interface ToolView { id: string; name: string; args: unknown; phase: "running" | "complete" | "error"; result?: unknown; interrupted?: boolean }
export interface FlowReportRecord { kind: string; text: string; timestamp?: number }
export interface ChatProjection {
  messages: ChatMessage[];
  activeMessage: number | null;
  tools: Record<string, ToolView>;
  flowReports: FlowReportRecord[];
  running: boolean;
  turnStartedAt?: number;
  compatibility: string[];
}
export function emptyProjection(): ChatProjection { return { messages: [], activeMessage: null, tools: {}, flowReports: [], running: false, turnStartedAt: undefined, compatibility: [] }; }
export function object(value: unknown): value is WireObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function contentShape(value: unknown): string {
  if (!Array.isArray(value)) return value === null ? "null" : typeof value;
  return `[${value.slice(0, 8).map(block => object(block) ? `type=${String(block.type)} keys=${Object.keys(block).join(",")}` : typeof block).join("; ")}]`;
}
export function parseMessage(value: unknown): ChatMessage {
  if (!object(value) || typeof value.role !== "string") throw new Error("Invalid runtime message");
  const content = typeof value.content === "string"
    ? [{ type: "text", text: value.content }]
    : value.content === undefined && value.role === "compactionSummary"
      ? []
      : value.content;
  if (!Array.isArray(content) || !content.every(block => object(block) && typeof block.type === "string")) throw new Error(`Invalid runtime message content (${String(value.role)}: ${contentShape(content)})`);
  return { ...value, role: value.role, content: content as ChatBlock[] };
}
export function historyProjection(messages: unknown): ChatProjection {
  if (!Array.isArray(messages)) throw new Error("Invalid runtime history");
  const parsed = messages.map(parseMessage);
  const tools: Record<string, ToolView> = {};
  for (const message of parsed) {
    for (const block of message.content) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        tools[block.id] = { id: block.id, name: block.name ?? "tool", args: block.arguments, phase: tools[block.id]?.phase ?? "running", result: tools[block.id]?.result };
      }
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const id = message.toolCallId;
      tools[id] = { id, name: message.toolName ?? tools[id]?.name ?? "tool", args: tools[id]?.args, phase: message.isError === true ? "error" : "complete", result: { content: message.content, details: message.details } };
    }
  }
  return { ...emptyProjection(), messages: parsed, tools };
}
/** Host history/`message.done` blocks in the shape the transcript renders. */
export function hostBlocks(blocks: unknown): ChatBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block): ChatBlock[] => {
    if (!object(block) || typeof block.type !== "string") return [];
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") return [{ type: "thinking", thinking: typeof block.text === "string" ? block.text : typeof block.thinking === "string" ? block.thinking : "" }];
    if (block.type === "toolCall") {
      const id = typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : "";
      return id ? [{ type: "toolCall", id, name: typeof block.name === "string" ? block.name : "tool", arguments: block.input ?? block.arguments }] : [];
    }
    // A tool's result is shown on its call (see `hostToolResults`), not as a block of its own.
    if (block.type === "toolResult") return [];
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    return [];
  });
}

/** The tool results a host row or `message.done` carries, keyed by tool call. */
export function hostToolResults(blocks: unknown, known: Record<string, ToolView>): Record<string, ToolView> {
  if (!Array.isArray(blocks)) return {};
  const calls = new Map<string, { name: string; args: unknown }>();
  const results: Record<string, ToolView> = {};
  for (const block of blocks) {
    if (!object(block)) continue;
    const id = typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : "";
    if (!id) continue;
    if (block.type === "toolCall") calls.set(id, { name: typeof block.name === "string" ? block.name : "tool", args: block.input ?? block.arguments });
    if (block.type === "toolResult") {
      const call = calls.get(id);
      results[id] = {
        id,
        name: known[id]?.name ?? call?.name ?? "tool",
        args: known[id]?.args ?? call?.args,
        phase: block.ok === false ? "error" : "complete",
        // The same value `tool.result` carried live.
        result: block.result ?? known[id]?.result,
        ...(block.interrupted === true ? { interrupted: true } : {}),
      };
    }
  }
  return results;
}

/** Images the user attached, as stored by the host with the user row. */
function attachmentBlocks(attachments: unknown): ChatBlock[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((item): ChatBlock[] => object(item) && typeof item.data === "string" && typeof item.mimeType === "string" && item.mimeType.startsWith("image/")
    ? [{ type: "image", data: item.data, mimeType: item.mimeType }]
    : []);
}

export function historyRowsProjection(rows: unknown): ChatProjection {
  if (!Array.isArray(rows)) throw new Error("Invalid host history");
  const messages: ChatMessage[] = [];
  const tools: Record<string, ToolView> = {};
  for (const row of rows) {
    if (!object(row)) continue;
    const kind = typeof row.kind === "string" ? row.kind : "";
    const timestamp = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : undefined;
    if (kind === "user" || kind === "assistant") {
      const content = [...hostBlocks(row.blocks), ...attachmentBlocks(row.attachments)];
      messages.push({
        role: kind,
        content,
        timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
        ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
        ...(typeof row.model === "string" ? { model: row.model } : {}),
        ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
        ...(typeof row.stopReason === "string" ? { stopReason: row.stopReason } : {}),
        ...(typeof row.errorMessage === "string" ? { errorMessage: row.errorMessage } : {}),
        ...(object(row.usage) ? { usage: row.usage as ChatMessage["usage"] } : {}),
      });
      for (const block of content) if (block.type === "toolCall" && typeof block.id === "string") tools[block.id] = { id: block.id, name: block.name ?? "tool", args: block.arguments, phase: tools[block.id]?.phase ?? "running", result: tools[block.id]?.result };
      Object.assign(tools, hostToolResults(row.blocks, tools));
      continue;
    }
    if (kind === "tool") {
      const tool = object(row.tool) ? row.tool : {};
      const id = typeof tool.callId === "string" ? tool.callId : typeof row.id === "string" ? row.id.replace(/^tool:/u, "") : "";
      if (!id) continue;
      const status = typeof tool.status === "string" ? tool.status : "running";
      tools[id] = {
        id,
        name: typeof tool.name === "string" ? tool.name : "tool",
        args: row.args,
        phase: status === "error" || status === "interrupted" ? "error" : status === "ok" ? "complete" : "running",
        result: row.result,
        ...(status === "interrupted" ? { interrupted: true } : {}),
      };
    }
  }
  return { ...emptyProjection(), messages, tools };
}

export function interruptUnfinishedTools(state: ChatProjection): ChatProjection {
  if (state.running) return state;
  let changed = false;
  const tools = Object.fromEntries(Object.entries(state.tools).map(([id, tool]) => {
    if (tool.phase !== "running") return [id, tool];
    changed = true;
    return [id, {
      ...tool,
      phase: "error" as const,
      interrupted: true,
      result: { content: [{ type: "text", text: "Interrupted" }] },
    }];
  }));
  return changed ? { ...state, tools } : state;
}
function compatibility(state: ChatProjection, type: string): ChatProjection {
  return { ...state, compatibility: [...new Set([...state.compatibility, type])].slice(-32) };
}
const passiveEvents = new Set(["turn_start", "turn_end", "agent_end", "queue_update", "entry_appended", "session_info_changed", "thinking_level_changed", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"]);
export function projectEvent(state: ChatProjection, event: WireObject): ChatProjection {
  const next = projectEventInner(state, event);
  return next.running ? next : interruptUnfinishedTools(next);
}
function projectEventInner(state: ChatProjection, event: WireObject): ChatProjection {
  const type = event.type;
  if (typeof type !== "string") throw new Error("Runtime event has no type");
  if (type === "agent_start") return { ...state, running: true, turnStartedAt: state.turnStartedAt ?? Date.now() };
  if (type === "agent_settled") return interruptUnfinishedTools({ ...state, running: false, turnStartedAt: undefined });
  if (type === "message_start") {
    const message = parseMessage(event.message);
    return { ...state, messages: [...state.messages, { ...message, timestamp: message.timestamp ?? Date.now() }], activeMessage: state.messages.length };
  }
  if (type === "message_end") {
    const message = parseMessage(event.message);
    if (state.activeMessage === null) throw new Error("Runtime ended a message without starting it");
    const active = state.messages[state.activeMessage];
    return { ...state, messages: state.messages.map((item, index) => index === state.activeMessage ? { ...message, timestamp: message.timestamp ?? active.timestamp, endedAt: Date.now(), usage: message.usage ?? active.usage } : item), activeMessage: null };
  }
  if (type === "message_update") {
    if (state.activeMessage === null || !object(event.assistantMessageEvent)) throw new Error("Runtime message update has no active message");
    const update = event.assistantMessageEvent;
    const index = update.contentIndex;
    if (typeof update.type !== "string") throw new Error("Invalid runtime content event");
    if (update.type === "start") return state;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 4095) throw new Error("Invalid runtime content index");
    const message = state.messages[state.activeMessage];
    const content = [...message.content];    const blockIndex = index as number;
    const previous = content[blockIndex];
    switch (update.type) {
      case "text_start": content[blockIndex] = { type: "text", text: "" }; break;
      case "thinking_start": content[blockIndex] = { type: "thinking", thinking: "" }; break;
      case "text_delta":
      case "thinking_delta": {
        if (typeof update.delta !== "string") throw new Error("Invalid runtime text delta");
        const thinking = update.type === "thinking_delta";
        if (previous?.type !== (thinking ? "thinking" : "text")) throw new Error("Runtime delta has no matching content block");
        content[blockIndex] = thinking ? { ...previous, thinking: (previous.thinking ?? "") + update.delta } : { ...previous, text: (previous.text ?? "") + update.delta };
        break;
      }
      case "text_end":
      case "thinking_end": {
        if (typeof update.content !== "string") throw new Error("Invalid completed runtime text");
        content[blockIndex] = update.type === "text_end" ? { type: "text", text: update.content } : { type: "thinking", thinking: update.content };
        break;
      }
      case "toolcall_start":
        if (typeof update.id !== "string" || typeof update.toolName !== "string") throw new Error("Invalid runtime tool call");
        content[blockIndex] = { type: "toolCall", id: update.id, name: update.toolName }; break;
      case "toolcall_delta": return state; // Partial JSON arguments are not executable or authoritative.
      case "toolcall_end":
        if (!object(update.toolCall) || update.toolCall.type !== "toolCall") throw new Error("Invalid completed runtime tool call");
        content[blockIndex] = update.toolCall as unknown as ChatBlock; break;
      default: return compatibility(state, `message_update:${update.type}`);
    }
    return { ...state, messages: state.messages.map((item, position) => position === state.activeMessage ? { ...message, content, ...(object(event.usage) ? { usage: event.usage as ChatMessage["usage"] } : {}) } : item) };
  }
  if (type === "custom_message" || type === "entry_appended") {
    const entry = type === "entry_appended" ? (object(event.entry) ? event.entry : undefined) : event;
    if (entry && typeof entry.customType === "string" && entry.customType.startsWith("jouzu-flow") && entry.display !== false) {
      const text = (Array.isArray(entry.content) ? entry.content : [])
        .map(block => object(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n");
      let kind: string | undefined;
      try { const parsed = JSON.parse(text); kind = object(parsed) && typeof parsed.kind === "string" ? parsed.kind : undefined; } catch { /* keep the raw text */ }
      if (text && kind) {
        const report = { kind, text, ...(typeof entry.timestamp === "number" ? { timestamp: entry.timestamp } : {}) };
        return { ...state, flowReports: [...state.flowReports, report].slice(-30) };
      }
    }
    if (type === "entry_appended") return state;
  }
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") throw new Error("Invalid runtime tool event");
    const prior = state.tools[event.toolCallId];
    if (type !== "tool_execution_start" && !prior) {
      // A resumed session can receive an update/end whose start was emitted before
      // the history snapshot. Recover the card instead of failing the whole stream.
      const recovered: ToolView = {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        phase: type === "tool_execution_end" ? event.isError === true ? "error" : "complete" : "running",
        result: type === "tool_execution_end" ? event.result : event.partialResult,
      };
      return { ...state, tools: { ...state.tools, [recovered.id]: recovered } };
    }
    const tool: ToolView = { id: event.toolCallId, name: event.toolName, args: event.args ?? prior?.args, phase: type === "tool_execution_end" ? event.isError === true ? "error" : "complete" : "running", result: type === "tool_execution_end" ? event.result : type === "tool_execution_update" ? event.partialResult : undefined };
    return { ...state, tools: { ...state.tools, [tool.id]: tool } };
  }
  if (passiveEvents.has(type)) return state;
  return compatibility(state, type);
}
