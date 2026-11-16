// Presentation-only projection of the released JSONL event contract.
// Agent history and completion remain authoritative in the runtime.
export type WireObject = Record<string, unknown>;
/** An image the host keeps for a message in history: fetched by id, never inlined in the row. */
export interface HostAttachmentRef { sessionId: string; id: string }
export interface ChatBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; data?: string; mimeType?: string; attachment?: HostAttachmentRef; content?: ChatBlock[]; toolCallId?: string; isError?: boolean }
export interface ChatMessage { role: string; content: ChatBlock[]; turnId?: string; /** The user turn this message belongs to (1 = the first user message), as the host numbers it. */ turn?: number; details?: unknown; timestamp?: number; endedAt?: number; stopReason?: string; errorMessage?: string; toolCallId?: string; toolName?: string; isError?: boolean; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; totalTokens?: number } }
export interface ToolView { id: string; name: string; args: unknown; phase: "running" | "complete" | "error"; result?: unknown; interrupted?: boolean }
export interface FlowReportRecord { kind: string; text: string; timestamp?: number }
export interface ChatProjection {
  messages: ChatMessage[];
  activeMessage: number | null;
  tools: Record<string, ToolView>;
  flowReports: FlowReportRecord[];
  running: boolean;
  turnStartedAt?: number;
  /**
   * Where `messages[0]` stands in the conversation relative to the first page
   * loaded: 0, or negative once earlier pages are put in front. Rows keep
   * their keys when earlier messages are loaded.
   */
  firstIndex?: number;
}
export function emptyProjection(): ChatProjection { return { messages: [], activeMessage: null, tools: {}, flowReports: [], running: false, turnStartedAt: undefined }; }
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

/**
 * Images the user attached, as the host lists them on the user row. A row names
 * each image by id (no data); the transcript fetches it from the host (#119).
 */
function attachmentBlocks(attachments: unknown, sessionId?: string): ChatBlock[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((item): ChatBlock[] => {
    if (!object(item) || typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/")) return [];
    if (typeof item.data === "string") return [{ type: "image", data: item.data, mimeType: item.mimeType }];
    if (typeof item.id === "string" && item.id && sessionId) return [{ type: "image", mimeType: item.mimeType, attachment: { sessionId, id: item.id } }];
    return [];
  });
}

/** Host history rows as the transcript; `sessionId` is the host session the rows (and their images) belong to. */
export function historyRowsProjection(rows: unknown, sessionId?: string): ChatProjection {
  if (!Array.isArray(rows)) throw new Error("Invalid host history");
  const messages: ChatMessage[] = [];
  const tools: Record<string, ToolView> = {};
  for (const row of rows) {
    if (!object(row)) continue;
    const kind = typeof row.kind === "string" ? row.kind : "";
    const timestamp = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : undefined;
    if (kind === "user" || kind === "assistant") {
      const content = [...hostBlocks(row.blocks), ...attachmentBlocks(row.attachments, sessionId)];
      messages.push({
        role: kind,
        content,
        timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
        ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
        ...(typeof row.turn === "number" && row.turn > 0 ? { turn: row.turn } : {}),
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

/**
 * The user turn (1 = the first user message of the conversation) that message
 * `index` belongs to, for branching. It is counted from the nearest message the
 * host numbered; messages added live after it count their own user messages.
 * With no numbered message, counting from the start is right only when the
 * whole conversation is loaded (`complete`); otherwise the turn is unknown.
 */
export function turnAt(messages: readonly ChatMessage[], index: number, complete: boolean): number | undefined {
  let users = 0;
  for (let at = Math.min(index, messages.length - 1); at >= 0; at -= 1) {
    const message = messages[at];
    if (typeof message.turn === "number" && message.turn > 0) return message.turn + users;
    if (message.role === "user") users += 1;
  }
  return complete && users > 0 ? users : undefined;
}

/**
 * A page of a saved session's runtime messages, as the preview shows it, with
 * each message numbered by user turn from `turn` (user messages before the page).
 */
export function savedPageProjection(messages: unknown, turn: number): ChatProjection {
  const projection = interruptUnfinishedTools(historyProjection(messages));
  let current = turn;
  return {
    ...projection,
    messages: projection.messages.map(message => {
      if (message.role === "user") current += 1;
      return current > 0 ? { ...message, turn: current } : message;
    }),
  };
}

/**
 * Earlier history put in front of what is loaded: messages and tool states
 * join at the start, and positions that point into the transcript move with it.
 */
export function prependHistory(state: ChatProjection, earlier: ChatProjection): ChatProjection {
  const count = earlier.messages.length;
  if (!count) return state;
  const tools: Record<string, ToolView> = { ...earlier.tools };
  // A call in the earlier page can have its result in the later one: the later state wins.
  for (const [id, tool] of Object.entries(state.tools)) tools[id] = tools[id] ? { ...tools[id], ...tool, args: tool.args ?? tools[id].args } : tool;
  return {
    ...state,
    messages: [...earlier.messages, ...state.messages],
    tools,
    activeMessage: state.activeMessage === null ? null : state.activeMessage + count,
    firstIndex: (state.firstIndex ?? 0) - count,
  };
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
