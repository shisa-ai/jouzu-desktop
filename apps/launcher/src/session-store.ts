/**
 * Host-backed session state for the UI.
 *
 * One Store owns one host session: attach, history, events, send and teardown.
 * Turn state (running, phase, start time, queue, failure, pending prompts) is
 * copied from the host's `session.updated` summary and never inferred locally.
 * The only UI-owned state is the outbox: messages sent but not yet confirmed.
 */
import { HostChatSession } from "./api/chat-session";
import { eventRouter } from "./event-router";
import type { ApiEvent, Attachment, HistoryPage, JouzuApi, Receipt, TimingMark } from "./api/jouzu-api";
import { emptyProjection, historyRowsProjection, hostBlocks, hostToolResults, type ChatBlock, type ChatMessage, type FlowReportRecord, type ToolView } from "./chat-projection";
import { describeError } from "./runtime-errors";
import { classifyNotice, type TextGuardMode } from "./session-notices";
import {
  readModelPreference,
  writeModelPreference,
  type ActiveTurn,
  type ChatImage,
  type ChatModel,
  type ChatSnapshot,
  type OutboxItem,
  type PendingPrompt,
  type QueuedMessage,
  type SessionStats,
  type TurnStep,
} from "./chat-types";

export interface SessionPort {
  readonly id: string;
  /** The saved file the host opened this session on, when it has one. */
  readonly sessionPath?: string | null;
  history(page?: { limit?: number; before?: number }): Promise<HistoryPage>;
  send(message: { clientMessageId: string; text: string; attachments?: Attachment[] }): Promise<Receipt>;
  interrupt(): Promise<void>;
  cancel(clientMessageId: string): Promise<void>;
  queue(action: "continue" | "discard" | "retry"): Promise<void>;
  stop(): Promise<void>;
  detach(): void;
  follow(onEvent: (event: ApiEvent) => void, onError: (error: unknown) => void): void;
}

const emptySnapshot = (): ChatSnapshot => ({
  projection: emptyProjection(),
  connected: false,
  pending: false,
  error: null,
  models: [],
  thinkingLevels: [],
  prompts: [],
  outbox: [],
  queue: [],
  activeTurn: null,
});

const modelOf = (model: Awaited<ReturnType<JouzuApi["models"]["list"]>>[number]): ChatModel => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  cost: model.cost,
  thinkingLevels: model.thinkingLevels,
});

type Data = Record<string, unknown>;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const record = (value: unknown): Data | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
const time = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

function activeTurnOf(value: unknown): ActiveTurn | null {
  const turn = record(value);
  const turnId = text(turn?.turnId);
  if (!turn || !turnId) return null;
  return { turnId, clientMessageId: text(turn.clientMessageId), phase: text(turn.phase) ?? "running", startedAt: time(turn.startedAt), step: stepOf(turn.step) };
}

/** A displayable Flow report: a jouzu-flow message whose text is a JSON object with a kind. */
export function flowReportOf(customType: string | undefined, display: unknown, body: string | undefined): FlowReportRecord | null {
  if (!customType?.startsWith("jouzu-flow") || display === false || !body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    const kind = record(parsed)?.kind;
    return typeof kind === "string" ? { kind, text: body, timestamp: Date.now() } : null;
  } catch {
    return null;
  }
}

function stepOf(value: unknown): TurnStep | undefined {
  const step = record(value);
  const state = text(step?.state);
  if (!step || !state) return undefined;
  const tools = Array.isArray(step.tools)
    ? step.tools.flatMap(tool => { const item = record(tool); const id = text(item?.id); return id ? [{ id, name: text(item?.name) ?? "tool" }] : []; })
    : [];
  const retry = record(step.retry);
  return {
    n: typeof step.n === "number" ? step.n : 0,
    state,
    since: time(step.since),
    tools,
    ...(retry ? { retry: { attempt: typeof retry.attempt === "number" ? retry.attempt : undefined, maxAttempts: typeof retry.maxAttempts === "number" ? retry.maxAttempts : undefined, error: text(retry.error) } } : {}),
  };
}

function widgetsOf(value: unknown): Record<string, string[]> {
  const data = record(value) ?? {};
  return Object.fromEntries(Object.entries(data).flatMap(([key, lines]) => {
    const list = Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string") : [];
    return list.length ? [[key, list]] : [];
  }));
}

function statusesOf(value: unknown): Record<string, string> {
  const data = record(value) ?? {};
  return Object.fromEntries(Object.entries(data).flatMap(([key, line]) => typeof line === "string" && line ? [[key, line]] : []));
}

function queueOf(value: unknown): QueuedMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const row = record(item);
    const clientMessageId = text(row?.clientMessageId);
    return row && clientMessageId ? [{ clientMessageId, text: text(row.text) ?? "", state: text(row.state) ?? "queued", images: typeof row.images === "number" ? row.images : 0 }] : [];
  });
}

export function approvalOf(value: unknown): PendingPrompt | null {
  const data = record(value);
  const id = text(data?.approvalId);
  if (!data || !id) return null;
  const args = record(data.args);
  const options = Array.isArray(data.options) ? data.options.filter((option): option is string => typeof option === "string") : [];
  return {
    kind: "approval",
    id,
    title: text(args?.title) ?? text(data.tool) ?? "Approval needed",
    message: text(args?.message) ?? "",
    options: options.length ? options : ["Approve", "Deny"],
    expiresAt: time(data.expiresAt),
  };
}

export function questionOf(value: unknown): PendingPrompt | null {
  const data = record(value);
  const id = text(data?.questionId);
  const first = record(Array.isArray(data?.questions) ? data.questions[0] : undefined);
  if (!data || !id || !first) return null;
  return {
    kind: "question",
    id,
    itemId: text(first.id) ?? "q1",
    title: text(first.header) ?? text(first.question) ?? "Question",
    message: text(first.detail) ?? (text(first.question) !== text(first.header) ? text(first.question) ?? "" : ""),
    options: Array.isArray(first.options) ? first.options.filter((option): option is string => typeof option === "string") : [],
    expiresAt: time(data.expiresAt),
  };
}

function promptsOf(approvals: unknown, questions: unknown): PendingPrompt[] | undefined {
  if (!Array.isArray(approvals) && !Array.isArray(questions)) return undefined;
  return [
    ...(Array.isArray(approvals) ? approvals.map(approvalOf) : []),
    ...(Array.isArray(questions) ? questions.map(questionOf) : []),
  ].filter((prompt): prompt is PendingPrompt => !!prompt);
}

const userRow = (item: Pick<OutboxItem, "text" | "images" | "at">, turnId?: string): ChatMessage => ({
  role: "user",
  content: [
    ...(item.text ? [{ type: "text", text: item.text }] : []),
    ...item.images.map((image): ChatBlock => ({ type: "image", data: image.data, mimeType: image.mimeType })),
  ],
  timestamp: item.at,
  ...(turnId ? { turnId } : {}),
});

function firstOutputOf(value: Record<string, unknown>) {
  const ms = (field: unknown) => typeof field === "number" && Number.isFinite(field) ? field : null;
  return { turns: ms(value.turns) ?? 0, avgMs: ms(value.avgMs), lastMs: ms(value.lastMs) };
}

export class SessionStore {
  private state: ChatSnapshot = emptySnapshot();
  private readonly listeners = new Set<(state: ChatSnapshot) => void>();
  private active = -1;
  /** Images of messages waiting in the host queue, so Edit can give them back. */
  private waitingImages = new Map<string, ChatImage[]>();
  private following = false;
  private routerUnsubscribe?: () => void;
  private disposed = false;
  private preferred = readModelPreference();
  private api?: JouzuApi;
  private noticeSeq = 0;
  private shownOutput: string | null = null;

  private constructor(
    readonly session: SessionPort,
    private readonly onDispose?: () => void,
  ) {
    // The file is known from the attach: a send right after opening a saved
    // session must see it is in that session, not wait for the first event.
    this.state = { ...this.state, sessionId: session.id, connected: true, ...(session.sessionPath ? { sessionFile: session.sessionPath } : {}) };
  }

  static async open(api: JouzuApi, workspacePath: string, sessionPath?: string): Promise<SessionStore> {
    const session = await HostChatSession.open(api, workspacePath, sessionPath);
    const store = SessionStore.attach(session, undefined, api);
    await store.load();
    return store;
  }

  static attach(session: SessionPort, onDispose?: () => void, api?: JouzuApi): SessionStore {
    const store = new SessionStore(session, onDispose);
    store.api = api;
    if (api) {
      store.resume();
    } else {
      // Unit tests drive a fake port directly.
      store.following = true;
      session.follow(event => store.handle(event), error => store.fail(error));
    }
    return store;
  }

  /** Subscribe to the one router stream; the store owns no socket. */
  resume(): void {
    if (this.disposed || this.following) return;
    this.following = true;
    this.routerUnsubscribe = eventRouter.subscribe(event => {
      if (event.event === "resync") {
        void this.refreshHistory();
        return;
      }
      if (event.sessionId !== this.session.id) return;
      this.handle(event);
    });
  }

  /** Stop listening to the router; this does not close any host session. */
  detachStream(): void {
    this.routerUnsubscribe?.();
    this.routerUnsubscribe = undefined;
    this.following = false;
  }

  /**
   * This store is on screen again. The host streams content only for the session
   * a client shows, so a store that sat in the background catches up from history.
   */
  view(): void {
    const view = this.api?.sessions.view;
    if (!view) return;
    void view(this.session.id).then(() => this.refreshHistory(), () => this.refreshHistory());
  }

  /**
   * The first thing a reply shows, as the host times it (`message.first_output`):
   * words, thinking, or a tool at work.
   */
  private markFirstOutput(turnId: string): void {
    if (this.shownOutput === turnId) return;
    this.shownOutput = turnId;
    this.markShown("first_output.shown", this.state.activeTurn?.clientMessageId);
  }

  /** Record, after the next paint, a moment the user saw (see host.log `timing.ui`). */
  private markShown(mark: TimingMark, clientMessageId?: string): void {
    const runtime = this.api?.runtime;
    if (!runtime?.mark) return;
    const sessionId = this.session.id;
    const record = () => runtime.mark?.(mark, { sessionId, clientMessageId });
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => record());
    else record();
  }

  private async load(): Promise<void> {
    await this.refreshHistory();
    await this.loadModels();
    this.loadThinkingLevels();
    await this.applyPreferredModel();
    void this.loadStats();
  }

  get snapshot(): ChatSnapshot {
    return this.state;
  }

  /** True while the host reports a turn in progress (any phase). */
  get running(): boolean {
    return !!this.state.activeTurn;
  }

  subscribe(listener: (state: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  isDisposed(): boolean { return this.disposed; }

  clearError(): void { this.update({ error: null }); }

  retryHistory(): Promise<void> { return this.refreshHistory(); }

  async loadHistory(): Promise<void> { await this.refreshHistory(); }

  async refreshHistory(): Promise<void> {
    try {
      const page = await this.session.history({ limit: 200 });
      // The host pages newest first (its in-flight partial row leads the page).
      // The transcript reads oldest first, so the partial reply ends up last.
      const rows = [...(page.messages as unknown as Data[])].reverse();
      let active = -1;
      let messageIndex = -1;
      for (const row of rows) {
        if (row.kind === "user" || row.kind === "assistant") messageIndex += 1;
        if (row.partial === true) active = messageIndex;
      }
      this.active = active;
      const projection = historyRowsProjection(rows);
      this.update({
        projection: { ...projection, running: this.running, turnStartedAt: this.state.activeTurn?.startedAt ?? this.state.projection.turnStartedAt, activeMessage: active >= 0 ? active : null },
        historyError: undefined,
      });
    } catch (error) {
      this.update({ historyError: describeError(error) });
    }
  }

  /**
   * Send. While a turn runs the host queues the message and hands it to that
   * turn (steer); it joins the transcript when the runtime uses it. The message is in
   * the outbox, and on screen, before the request leaves; the host's receipt
   * turns it into a transcript row. A failure keeps it as "not sent".
   */
  async send(messageText: string, images: readonly ChatImage[] = [], clientMessageId: string = crypto.randomUUID()): Promise<Receipt> {
    const existing = this.state.outbox?.find(item => item.clientMessageId === clientMessageId);
    const item: OutboxItem = existing
      ? { ...existing, state: "sending", error: undefined }
      : { clientMessageId, text: messageText, images: [...images], state: "sending", at: Date.now() };
    this.setOutbox([...(this.state.outbox ?? []).filter(entry => entry.clientMessageId !== clientMessageId), item]);
    if (!existing) this.markShown("message.shown", clientMessageId);
    try {
      const receipt = await this.session.send({
        clientMessageId,
        text: item.text,
        attachments: item.images.map((image, index) => ({ name: `image-${index + 1}`, mimeType: image.mimeType, data: image.data })),
      });
      this.confirm(item, receipt);
      return receipt;
    } catch (error) {
      if (this.state.outbox?.some(entry => entry.clientMessageId === clientMessageId)) {
        this.setOutbox((this.state.outbox ?? []).map(entry => entry.clientMessageId === clientMessageId ? { ...entry, state: "failed", error: describeError(error) } : entry));
      }
      throw error;
    }
  }

  /** Resend a failed outbox item with its original id (the host deduplicates). */
  retry(clientMessageId: string): Promise<Receipt> | undefined {
    const item = this.state.outbox?.find(entry => entry.clientMessageId === clientMessageId);
    return item ? this.send(item.text, item.images, clientMessageId) : undefined;
  }

  /** Drop an unsent item; the host is told too in case the request did land. */
  discard(clientMessageId: string): void {
    this.setOutbox((this.state.outbox ?? []).filter(entry => entry.clientMessageId !== clientMessageId));
    void this.session.cancel(clientMessageId).catch(() => {});
  }

  private confirm(item: OutboxItem, receipt: Receipt): void {
    const outbox = (this.state.outbox ?? []).filter(entry => entry.clientMessageId !== item.clientMessageId);
    if (receipt.receipt === "cancelled") { this.setOutbox(outbox); return; }
    // Waiting in the session's queue (shown above the composer), not yet in the conversation.
    if (receipt.waiting) {
      if (item.images.length) this.waitingImages.set(item.clientMessageId, item.images);
      this.update({ outbox, pending: outbox.some(entry => entry.state === "sending"), flowHold: null });
      return;
    }
    const turnId = typeof receipt.messageId === "string" ? receipt.messageId : undefined;
    const current = this.state.projection.messages;
    // A fast reply can start streaming before the POST returns. The user row
    // belongs before the assistant row of its own turn.
    if (turnId && current.some(message => message.role === "user" && message.turnId === turnId)) { this.setOutbox(outbox); return; }
    const at = turnId ? current.findIndex(message => message.role === "assistant" && message.turnId === turnId) : -1;
    const row = userRow(item, turnId);
    const messages = at >= 0 ? [...current.slice(0, at), row, ...current.slice(at)] : [...current, row];
    if (at >= 0 && this.active >= at) this.active += 1;
    this.update({
      outbox,
      pending: outbox.some(entry => entry.state === "sending"),
      // A new message is the user continuing; a hold that still applies is announced again.
      flowHold: null,
      projection: { ...this.state.projection, messages, activeMessage: this.active >= 0 ? this.active : this.state.projection.activeMessage },
    });
  }

  private setOutbox(outbox: OutboxItem[]): void {
    this.update({ outbox, pending: outbox.some(entry => entry.state === "sending") });
  }

  async loadModels(): Promise<void> {
    try {
      if (!this.api) return;
      const models = (await this.api.models.list(this.session.id)).map(modelOf);
      this.update({ models, modelsLoaded: true });
    } catch {
      // The composer shows "No models available" with a retry; no second error surface.
      this.update({ modelsLoaded: true });
    }
  }

  async selectModel(provider: string, id: string): Promise<void> {
    if (!this.api) return;
    await this.api.models.select(this.session.id, provider, id);
    const name = this.state.models?.find(model => model.provider === provider && model.id === id)?.name ?? id;
    this.preferred = { provider, id };
    writeModelPreference(this.preferred);
    this.update({ model: name, modelProvider: provider, modelId: id });
  }

  loadThinkingLevels(): void {
    const levels = new Set<string>();
    for (const model of this.state.models ?? []) for (const level of model.thinkingLevels ?? []) levels.add(level);
    this.update({ thinkingLevels: [...levels] });
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.api) return;
    await this.api.models.thinking(this.session.id, level);
    this.update({ thinkingLevel: level });
  }

  async loadStats(): Promise<void> {
    try {
      if (!this.api) return;
      const data = await this.api.commands.stats(this.session.id);
      this.update({ stats: data && typeof data === "object" ? data as SessionStats : undefined });
    } catch { /* Session counters are ancillary; chat remains usable. */ }
  }

  async runCommand(command: string): Promise<void> {
    if (this.running) throw new Error("Wait for the current turn to finish before running a command.");
    await this.session.send({ clientMessageId: crypto.randomUUID(), text: command });
  }

  /** TextGuard's three modes; the runtime's reply confirms the mode shown. */
  async setTextGuardMode(mode: TextGuardMode): Promise<void> {
    await this.runCommand(`/textguard ${mode}`);
    if (mode === "off") this.update({ textguard: { ...this.state.textguard, alert: undefined } });
  }

  dismissTextGuardAlert(): void {
    this.update({ textguard: { ...this.state.textguard, alert: undefined } });
  }

  /**
   * The Flow controls a held message needs: clear releases the hold, resume
   * lifts a pause, off lets retained input run natively. A successful command
   * ends the hold banner; the runtime's reply arrives as a notice.
   */
  async flow(verb: "clear" | "resume" | "off" | "on" | "status"): Promise<void> {
    await this.runCommand(verb === "status" ? "/flow" : `/flow ${verb}`);
    if (verb === "clear" || verb === "resume" || verb === "off") this.update({ flowHold: null });
  }

  dismissFlowHold(): void {
    this.update({ flowHold: null });
  }

  /**
   * Stop: cancel everything this window still has in flight, then the turn the
   * host is running. The host's cancel works in every phase (tombstone before
   * acceptance, removal while starting, abort while running).
   */
  async stop(): Promise<void> {
    const pending = (this.state.outbox ?? []).filter(entry => entry.state === "sending");
    const turn = this.state.activeTurn;
    const ids = new Set(pending.map(entry => entry.clientMessageId));
    if (turn?.clientMessageId) ids.add(turn.clientMessageId);
    if (pending.length) this.setOutbox((this.state.outbox ?? []).filter(entry => entry.state !== "sending"));
    if (turn) this.update({ activeTurn: { ...turn, phase: "cancelling" } });
    if (turn || pending.length) this.markShown("stop.shown", turn?.clientMessageId ?? pending[0]?.clientMessageId);
    try {
      if (ids.size) await Promise.all([...ids].map(id => this.session.cancel(id)));
      else if (turn) await this.session.interrupt();
    } catch (error) {
      // Stop did not take effect: put back what it took away. The messages
      // still being sent finish or fail on their own, as if Stop was not pressed.
      const outbox = this.state.outbox ?? [];
      const restore = pending.filter(entry => !outbox.some(item => item.clientMessageId === entry.clientMessageId));
      if (restore.length) this.setOutbox([...outbox, ...restore]);
      if (turn && this.state.activeTurn?.turnId === turn.turnId && this.state.activeTurn.phase === "cancelling") this.update({ activeTurn: turn });
      this.update({ error: describeError(error) });
    }
  }

  /** Remove a waiting message; it never reaches the runtime. */
  async unqueue(clientMessageId: string): Promise<void> {
    this.waitingImages.delete(clientMessageId);
    try { await this.session.cancel(clientMessageId); }
    catch (error) { this.update({ error: describeError(error) }); }
  }

  /** Take a waiting message back to edit it: its text and images, removed from the queue. */
  async takeQueued(clientMessageId: string): Promise<{ text: string; images: ChatImage[] } | null> {
    const item = this.state.queue?.find(entry => entry.clientMessageId === clientMessageId);
    if (!item) return null;
    const images = this.waitingImages.get(clientMessageId) ?? [];
    await this.unqueue(clientMessageId);
    return { text: item.text, images };
  }

  async queue(action: "continue" | "discard" | "retry"): Promise<void> {
    try { await this.session.queue(action); }
    catch (error) { this.update({ error: describeError(error) }); }
  }

  async compactSession(): Promise<void> {
    if (!this.api) return;
    await this.api.commands.compact(this.session.id);
    await this.refreshHistory();
  }

  async exportHtml(outputPath: string): Promise<void> {
    if (!this.api) return;
    await this.api.commands.exportHtml(this.session.id, outputPath);
  }

  async reloadSession(): Promise<void> {
    if (!this.api) return;
    await this.api.commands.reload(this.session.id);
    await this.refreshHistory();
    await this.loadModels();
  }

  /**
   * Answer a pending approval or question with the exact option the host
   * offered. The card is removed only when the host accepts the answer (or it
   * was already resolved); otherwise it stays and the error is returned.
   */
  async answer(prompt: PendingPrompt, value: string): Promise<void> {
    if (!this.api) return;
    try {
      if (prompt.kind === "approval") await this.api.prompts.approve(prompt.id, value);
      else await this.api.prompts.answer(prompt.id, { [prompt.itemId ?? "q1"]: value });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "prompt-resolved" && code !== "prompt-expired") throw error;
    }
    this.removePrompt(prompt.id);
  }

  close(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.detachStream();
    this.session.detach();
    this.listeners.clear();
    return this.session.stop().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachStream();
    this.session.detach();
    this.onDispose?.();
    this.listeners.clear();
  }

  private fail(error: unknown): void {
    this.update({ connected: false, error: describeError(error) });
  }

  private update(patch: Partial<ChatSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private async applyPreferredModel(): Promise<void> {
    const preferred = this.preferred;
    if (!preferred) return;
    if (this.state.modelProvider === preferred.provider && this.state.modelId === preferred.id) return;
    if (!this.state.models?.some(model => model.provider === preferred.provider && model.id === preferred.id)) {
      this.preferred = undefined;
      writeModelPreference(undefined);
      return;
    }
    try { await this.selectModel(preferred.provider, preferred.id); }
    catch {
      this.preferred = undefined;
      writeModelPreference(undefined);
    }
  }

  private addPrompt(prompt: PendingPrompt | null): void {
    if (!prompt) return;
    const prompts = this.state.prompts ?? [];
    if (prompts.some(item => item.id === prompt.id)) return;
    this.update({ prompts: [...prompts, prompt] });
  }

  private removePrompt(id: unknown): void {
    if (typeof id !== "string") return;
    const prompts = this.state.prompts ?? [];
    if (prompts.some(item => item.id === id)) this.update({ prompts: prompts.filter(item => item.id !== id) });
  }

  /** Apply the host's turn state. Running, its start time and phase come only from here. */
  private applyTurn(activeTurn: ActiveTurn | null): void {
    const previous = this.state.activeTurn;
    const startedAt = activeTurn
      ? activeTurn.startedAt ?? (previous?.turnId === activeTurn.turnId ? previous.startedAt : undefined) ?? Date.now()
      : undefined;
    const turn = activeTurn ? { ...activeTurn, startedAt } : null;
    this.update({
      activeTurn: turn,
      projection: {
        ...this.state.projection,
        running: !!turn,
        turnStartedAt: startedAt,
        ...(turn ? {} : { activeMessage: null }),
      },
    });
    if (!turn) this.active = -1;
  }

  private applySummary(data: Data): void {
    const prompts = promptsOf(data.pendingApprovals, data.pendingQuestions);
    const failed = record(data.failedTurn);
    // The host owns the session's model; show what it reports.
    const selected = record(data.model);
    const provider = selected ? text(selected.provider) : undefined;
    const id = selected ? text(selected.id) : undefined;
    const name = provider && id ? this.state.models?.find(model => model.provider === provider && model.id === id)?.name ?? text(selected?.name) ?? id : undefined;
    this.update({
      ...(provider && id ? { model: name, modelProvider: provider, modelId: id } : {}),
      sessionId: text(data.sessionId) ?? this.state.sessionId,
      sessionFile: text(data.sessionPath) ?? this.state.sessionFile,
      status: text(data.status) ?? this.state.status,
      ...(text(data.thinkingLevel) ? { thinkingLevel: text(data.thinkingLevel) } : {}),
      ...(record(data.firstOutput) ? { firstOutput: firstOutputOf(record(data.firstOutput)!) } : {}),
      ...("queue" in data ? { queue: queueOf(data.queue) } : {}),
      ...("failedTurn" in data ? { failedTurn: failed && text(failed.clientMessageId) ? { clientMessageId: text(failed.clientMessageId)!, text: text(failed.text) ?? "" } : null } : {}),
      ...(prompts ? { prompts } : {}),
      ...("widgets" in data ? { widgets: widgetsOf(data.widgets) } : {}),
      ...("statuses" in data ? { statuses: statusesOf(data.statuses) } : {}),
    });
    if ("activeTurn" in data) this.applyTurn(activeTurnOf(data.activeTurn));
  }

  private applyNotice(message: string, level: unknown): void {
    if (!message.trim()) return;
    const notice = classifyNotice(message, level);
    if (notice.kind === "textguard-mode") {
      this.update({ textguard: { ...this.state.textguard, mode: notice.mode }, notice: { id: ++this.noticeSeq, text: notice.text, level: "info" } });
    } else if (notice.kind === "textguard-alert") {
      this.update({ textguard: { ...this.state.textguard, alert: notice.text } });
    } else if (notice.kind === "flow-hold") {
      this.update({ flowHold: { text: notice.text, paused: notice.paused } });
    } else {
      this.update({ notice: { id: ++this.noticeSeq, text: notice.text, level: notice.level } });
    }
  }

  private ensureAssistant(turnId?: string): number {
    if (this.active >= 0 && this.state.projection.messages[this.active]?.role === "assistant") return this.active;
    const current = this.state.projection.messages;
    // A follow-up can be accepted (and shown) before the running turn's reply
    // starts. The reply belongs to its own turn, ahead of later user rows.
    const own = turnId ? current.findIndex(message => message.role === "user" && message.turnId === turnId) : -1;
    const later = own < 0 ? -1 : current.findIndex((message, index) => index > own && message.role === "user" && message.turnId !== turnId);
    const at = later < 0 ? current.length : later;
    const messages = [...current.slice(0, at), { role: "assistant", content: [], timestamp: Date.now(), ...(turnId ? { turnId } : {}) }, ...current.slice(at)];
    this.active = at;
    this.update({ projection: { ...this.state.projection, messages, activeMessage: at } });
    return at;
  }

  private handle(event: ApiEvent): void {
    const data = (event.data ?? {}) as Data;
    switch (event.event) {
      case "session.snapshot": {
        const empty = this.state.projection.messages.length === 0;
        this.update({
          sessionId: text(data.sessionId) ?? this.state.sessionId,
          sessionFile: text(data.sessionPath) ?? this.state.sessionFile,
          status: text(data.status) ?? this.state.status,
          model: text(data.model) ?? this.state.model,
          thinkingLevel: text(data.thinkingLevel) ?? this.state.thinkingLevel,
          thinkingLevels: Array.isArray(data.thinkingLevels) ? data.thinkingLevels.filter((level): level is string => typeof level === "string") : this.state.thinkingLevels,
        });
        const prompts = promptsOf(data.pendingApprovals, data.pendingQuestions);
        if (prompts) this.update({ prompts });
        if ("widgets" in data || "statuses" in data) this.update({ widgets: widgetsOf(data.widgets), statuses: statusesOf(data.statuses) });
        // The snapshot names the active turn by id only; keep what we know of it.
        const turnId = text(data.activeTurn);
        if (turnId) this.applyTurn(this.state.activeTurn?.turnId === turnId ? this.state.activeTurn : { turnId, phase: "running" });
        else if ("activeTurn" in data) this.applyTurn(null);
        // The stream can attach after turns already happened: reload the transcript.
        if (empty && typeof data.cursor === "number" && data.cursor > 0) void this.refreshHistory();
        break;
      }
      case "session.updated":
        this.applySummary(data);
        break;
      case "session.history":
        // The host replaced this session's history (a saved transcript arrived).
        void this.refreshHistory();
        break;
      case "session.attached":
        this.update({ sessionFile: text(data.sessionPath) ?? this.state.sessionFile });
        break;
      case "session.status":
        this.update({ status: text(data.status) ?? this.state.status });
        if (data.status === "stopped") this.update({ connected: false });
        break;
      case "turn.start": {
        // `session.updated` follows with the full turn; this only covers ordering.
        const turnId = text(data.turnId);
        if (turnId && this.state.activeTurn?.turnId !== turnId) this.applyTurn({ turnId, phase: text(data.phase) ?? "running" });
        break;
      }
      case "turn.end":
        if (!this.state.activeTurn || this.state.activeTurn.turnId === text(data.turnId)) this.applyTurn(null);
        break;
      case "message.user": {
        // A waiting message the runtime used: it joins the conversation where it happened.
        const message = historyRowsProjection([data]).messages[0];
        if (!message) break;
        const id = text(data.clientMessageId);
        const images = id ? this.waitingImages.get(id) : undefined;
        if (id) this.waitingImages.delete(id);
        const content = images?.length && !message.content.some(block => block.type === "image")
          ? [...message.content, ...images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))]
          : message.content;
        const current = this.state.projection.messages;
        const at = this.active >= 0 && this.active === current.length - 1 ? this.active : current.length;
        if (at === this.active) this.active += 1;
        const messages = [...current.slice(0, at), { ...message, content }, ...current.slice(at)];
        this.update({ projection: { ...this.state.projection, messages, activeMessage: this.active >= 0 ? this.active : this.state.projection.activeMessage } });
        break;
      }
      case "message.start":
        this.active = -1;
        this.ensureAssistant(text(data.turnId));
        break;
      case "message.delta": {
        const delta = text(data.text) ?? "";
        if (!delta) break;
        const at = this.ensureAssistant(text(data.turnId));
        const thinking = data.kind === "thinking";
        const messages = this.state.projection.messages.map((message, index) => {
          if (index !== at) return message;
          const content = [...message.content];
          const last = content.at(-1);
          // Text after a tool call is a new block, so the transcript keeps order.
          if (last && last.type === (thinking ? "thinking" : "text")) {
            content[content.length - 1] = thinking
              ? { ...last, thinking: `${last.thinking ?? ""}${delta}` }
              : { ...last, text: `${last.text ?? ""}${delta}` };
          } else content.push(thinking ? { type: "thinking", thinking: delta } : { type: "text", text: delta });
          return { ...message, content };
        });
        this.update({ projection: { ...this.state.projection, messages } });
        this.markFirstOutput(text(data.turnId) ?? text(data.messageId) ?? "");
        break;
      }
      case "message.done": {
        if (this.active < 0) break;
        const at = this.active;
        const blocks = hostBlocks(data.blocks);
        const messages = this.state.projection.messages.map((message, index) => index === at
          ? {
            ...message,
            content: blocks.length ? blocks : message.content,
            ...(text(data.stopReason) ? { stopReason: text(data.stopReason) } : {}),
            ...(text(data.errorMessage) ? { errorMessage: text(data.errorMessage) } : {}),
            ...(text(data.model) ? { model: text(data.model) } : {}),
            ...(text(data.provider) ? { provider: text(data.provider) } : {}),
            ...(record(data.usage) ? { usage: data.usage as ChatMessage["usage"] } : {}),
          }
          : message);
        // The turn may continue (more tools); only `turn.end` / the summary end it.
        const tools = { ...this.state.projection.tools };
        for (const [id, tool] of Object.entries(hostToolResults(data.blocks, tools))) if (!tools[id] || tools[id].phase === "running") tools[id] = tool;
        this.update({ projection: { ...this.state.projection, messages, tools, activeMessage: null } });
        this.active = -1;
        break;
      }
      case "tool.start": {
        const id = text(data.toolCallId) ?? "";
        if (!id) break;
        const tool: ToolView = { id, name: text(data.toolName) ?? "tool", args: data.args, phase: "running" };
        // The call is in the step's reply once that reply is written; a call the
        // reply does not hold yet is shown in the reply being written.
        const holder = this.state.projection.messages.findIndex(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === id));
        const at = holder >= 0 ? holder : this.ensureAssistant(text(data.turnId));
        const messages = this.state.projection.messages.map((message, index) => index === at && !message.content.some(block => block.type === "toolCall" && block.id === id)
          ? { ...message, content: [...message.content, { type: "toolCall", id, name: tool.name, arguments: data.args }] }
          : message);
        this.update({ projection: { ...this.state.projection, messages, tools: { ...this.state.projection.tools, [id]: tool } } });
        this.markFirstOutput(text(data.turnId) ?? this.state.activeTurn?.turnId ?? "");
        break;
      }
      case "tool.update": {
        const id = text(data.toolCallId) ?? "";
        const prior = this.state.projection.tools[id];
        if (!id || !prior) break;
        this.update({ projection: { ...this.state.projection, tools: { ...this.state.projection.tools, [id]: { ...prior, result: data.partialResult } } } });
        break;
      }
      case "tool.result": {
        const id = text(data.toolCallId) ?? "";
        if (!id) break;
        const prior = this.state.projection.tools[id];
        const tool: ToolView = { id, name: prior?.name ?? "tool", args: prior?.args, phase: data.ok === false ? "error" : "complete", result: data.result, ...(data.interrupted === true ? { interrupted: true } : {}) };
        this.update({ projection: { ...this.state.projection, tools: { ...this.state.projection.tools, [id]: tool } } });
        break;
      }
      case "approval.requested":
        this.addPrompt(approvalOf(data));
        break;
      case "question.requested":
        this.addPrompt(questionOf(data));
        break;
      case "approval.resolved":
        this.removePrompt(data.approvalId);
        break;
      case "question.answered":
      case "question.cancelled":
        this.removePrompt(data.questionId);
        break;
      case "message.custom":
      {
        // A Flow report the runtime shows, as it arrives (saved ones come from the host's report list).
        const report = flowReportOf(text(data.customType), data.display, text(data.text));
        if (report) this.update({ projection: { ...this.state.projection, flowReports: [...this.state.projection.flowReports, report].slice(-30) } });
        break;
      }
      case "session.notice":
        this.applyNotice(text(data.message) ?? "", data.level);
        break;
      case "error":
        // Turn state is not touched here: the host's summary says whether the turn ended.
        this.update({ error: text(data.message) ?? "The model runtime reported an error." });
        break;
      default:
        break;
    }
  }
}

const entryKey = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();

/** Live stores, one per session path; the host owns the runtime behind them. */
export class SessionPool {
  private readonly entries = new Map<string, SessionStore>();
  private readonly watches = new Map<SessionStore, () => void>();
  private readonly statusListeners = new Set<() => void>();
  private statusSignature = "";
  private readonly maxSessions = 30;

  constructor(private readonly api: JouzuApi) {}

  client(sessionPath: string): SessionStore | undefined {
    const key = entryKey(sessionPath);
    const store = this.entries.get(key);
    if (!store) return undefined;
    if (store.isDisposed()) {
      this.entries.delete(key);
      this.unwatch(store);
      this.emitStatus();
      return undefined;
    }
    if (!store.snapshot.connected) {
      this.entries.delete(key);
      this.unwatch(store);
      void store.close();
      this.emitStatus();
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, store);
    this.watch(store);
    store.view();
    return store;
  }

  isRunning(sessionPath: string): boolean {
    const store = this.entries.get(entryKey(sessionPath));
    return !!store && store.snapshot.connected && store.snapshot.projection.running;
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private watch(store: SessionStore): void {
    if (this.watches.has(store)) return;
    this.watches.set(store, store.subscribe(() => this.emitStatus()));
  }

  private unwatch(store: SessionStore): void {
    this.watches.get(store)?.();
    this.watches.delete(store);
  }

  private emitStatus(): void {
    const signature = [...this.entries]
      .map(([key, store]) => `${key}:${store.snapshot.connected && store.snapshot.projection.running ? 1 : 0}`)
      .sort()
      .join("|");
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    for (const listener of this.statusListeners) listener();
  }

  async lease(
    path: string,
    sessionPath?: string,
  ): Promise<SessionStore> {
    return SessionStore.open(this.api, path, sessionPath);
  }

  async enter(path: string, sessionPath: string): Promise<SessionStore> {
    const key = entryKey(sessionPath);
    const cached = this.entries.get(key);
    if (cached && !cached.isDisposed() && cached.snapshot.connected) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.watch(cached);
      cached.view();
      return cached;
    }
    if (cached) { this.entries.delete(key); this.unwatch(cached); void cached.close(); }
    const store = await this.lease(path, sessionPath);
    this.remember(sessionPath, store);
    return store;
  }

  forget(sessionPath: string): void {
    const key = entryKey(sessionPath);
    const store = this.entries.get(key);
    this.entries.delete(key);
    if (store) { this.unwatch(store); void store.close(); }
    this.emitStatus();
  }

  remember(sessionPath: string, store: SessionStore): void {
    const key = entryKey(sessionPath);
    const previous = this.entries.get(key);
    if (previous && previous !== store) {
      this.unwatch(previous);
      void previous.close();
    }
    this.entries.set(key, store);
    this.watch(store);
    this.emitStatus();
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted && evicted !== store) { this.unwatch(evicted); void evicted.close(); }
      this.emitStatus();
    }
  }
}

let sharedPool: SessionPool | undefined;

/** Called once by the app shell before ChatWorkspace mounts. */
export function configureSessionPool(api: JouzuApi): void {
  sharedPool = new SessionPool(api);
}

function pool(): SessionPool {
  if (!sharedPool) throw new Error("The session pool is not configured.");
  return sharedPool;
}

/** Stable facade used by ChatWorkspace; delegates to the configured pool. */
export const chatPool = {
  lease: (...args: Parameters<SessionPool["lease"]>) => pool().lease(...args),
  enter: (...args: Parameters<SessionPool["enter"]>) => pool().enter(...args),
  client: (path: string) => pool().client(path),
  isRunning: (path: string) => pool().isRunning(path),
  remember: (path: string, store: SessionStore) => pool().remember(path, store),
  forget: (path: string) => pool().forget(path),
  subscribeStatus: (listener: () => void) => pool().subscribeStatus(listener),
};
