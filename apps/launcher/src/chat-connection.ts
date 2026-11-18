import { invoke } from "@tauri-apps/api/core";
import { emptyProjection, historyProjection, interruptUnfinishedTools, object, projectEvent, type ChatProjection, type WireObject } from "./chat-projection";

/** One id per page load: handles from an older page are released by chat_release_generation. */
export const pageGeneration = globalThis.crypto.randomUUID();

export interface ChatImage { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }
export interface ChatModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}
interface CatalogModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ChatModel["cost"];
}
function hasCost(cost: ChatModel["cost"]): boolean {
  return !!cost && Object.values(cost).some(value => typeof value === "number" && value !== 0);
}
export interface SessionStats {
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  contextUsage?: { percent?: number | null; tokens?: number; contextWindow?: number };
}
export interface SessionTiming { modelMs: number; toolMs: number; turns: number; steps: number; outputTokens: number }
const MODEL_PREFERENCE_KEY = "jouzu.chat.model";
/** Flow notices belong in the Flow panel; strip their terminal-command instruction. */
export function flowNoticeText(message: string): string | undefined {
  if (!/\/flow\b/iu.test(message)) return undefined;
  const text = message
    .replace(/\s*Run \/flow[^.]*\.?/giu, "")
    .replace(/\s*Inspect with \/flow[^.]*\.?/giu, "")
    .trim();
  return text || "Flow needs attention.";
}
function readModelPreference(): { provider: string; id: string } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_PREFERENCE_KEY) ?? "null");
    return value && typeof value.provider === "string" && typeof value.id === "string" ? value : undefined;
  } catch { return undefined; }
}
function writeModelPreference(value: { provider: string; id: string } | undefined) {
  try {
    if (value) localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(value));
    else localStorage.removeItem(MODEL_PREFERENCE_KEY);
  } catch { /* A webview without storage keeps the selection for this session only. */ }
}
export interface ChatSnapshot {  projection: ChatProjection;
  connected: boolean;
  transportReady?: boolean;
  pending: boolean;
  error: string | null;
  /** The runtime is reachable but its transcript could not be read. */
  historyError?: string;
  sessionId?: string;
  sessionFile?: string;
  model?: string;
  modelProvider?: string;
  modelId?: string;
  models?: ChatModel[];
  modelsLoaded?: boolean;
  widgets?: Record<string, string[]>;
  statuses?: Record<string, string>;
  flowNotice?: string;
  stats?: SessionStats;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  /** The transcript was compacted after a display backlog and will be reloaded. */
  gap?: boolean;
}
interface Poll { records: WireObject[]; closed: boolean; error?: string }
// A response watchdog, not a request deadline: the released runtime owns how long a command
// takes, and a lost answer is only distinguishable from a slow one by waiting a long time.
const RESPONSE_WATCHDOG = 5 * 60_000;
const POLL_IDLE_MS = 30;
const POLL_ACTIVE_MS = 5;
// poll() and its response watchdog only start after chat_start returns, so a hung chat_start
// would otherwise wait forever and strand the user on "Starting session…". Bound just the
// spawn; the handshake after it (a slow cold start, a startup dialog the user is deciding) is
// deliberately allowed to run long and is governed by the response watchdog instead.
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_TIMEOUT_MESSAGE = "The session didn't start in time.";
// A desktop connection, not an agent loop: never retries a prompt or writes history.
export class ChatConnection {
  private handle?: string;
  private disposed = false;
  private failed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private replaying = false;
  private gapPending = false;
  private nextId = 0;
  private dialogs = new Map<string, number | null>();
  private lastPoll = Date.now();
  private preferredModel = readModelPreference();
  private requests = new Map<string, { command: string; resolve: (value: unknown) => void; reject: (error: Error) => void; deadline: number }>();
  snapshot: ChatSnapshot = { projection: emptyProjection(), connected: false, pending: false, error: null, models: [], thinkingLevels: [] };
  private subscribers = new Set<(state: ChatSnapshot) => void>();
  constructor(publish: (state: ChatSnapshot) => void, private dialog: (request: WireObject, client: ChatConnection) => void) {
    this.subscribers.add(publish);
  }
  /** A pool-owned connection can outlive one view; views subscribe instead of owning the callback. */
  subscribe(listener: (state: ChatSnapshot) => void): () => void {
    this.subscribers.add(listener);
    listener(this.snapshot);
    return () => { this.subscribers.delete(listener); };
  }
  setDialogHandler(handler: (request: WireObject, client: ChatConnection) => void) { this.dialog = handler; }
  isDisposed() { return this.disposed; }
  private update(change: Partial<ChatSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; if (!this.disposed) for (const listener of this.subscribers) listener(this.snapshot); }
  private external = false;
  private armStartupTimeout() {
    this.clearStartupTimeout();
    this.startupTimer = setTimeout(() => {
      if (!this.disposed && !this.failed && !this.snapshot.connected) this.fail(new Error(STARTUP_TIMEOUT_MESSAGE));
    }, STARTUP_TIMEOUT_MS);
  }
  private clearStartupTimeout() {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = undefined; }
  }

  async start(path: string, fresh = false, key = path, external = false) {
    this.external = external;
    // The runtime replays historical messages as ordinary wire events while the
    // connection attaches. Suppress those events until get_messages has supplied
    // the authoritative transcript, so opening a saved session never animates it.
    this.replaying = true;
    this.armStartupTimeout();
    try {
      await invoke("chat_release_generation", { generation: pageGeneration });
      const handle = await invoke<string>("chat_start", { path, generation: pageGeneration, key });
      this.clearStartupTimeout();
      if (this.disposed || this.failed) { await invoke("chat_stop", { handle }); return; }
      this.handle = handle;
      this.update({ transportReady: true });
      this.poll();
      // Wait for the runtime RPC loop to answer before replacing the session. Sending
      // new_session before this handshake can close Flow before it has attached.
      await this.refreshHistory();
      if (fresh) {
        const result = await this.request("new_session");
        if (object(result) && result.cancelled === true) throw new Error("The runtime cancelled the new session.");
        await this.refreshHistory();
      }
      this.update({ connected: true });
      await this.applyPreferredModel();
      this.replaying = false;
      void this.loadModels();
      void this.loadStats();
      void this.loadThinkingLevels();
    } catch (error) {
      this.replaying = false;
      this.fail(error);
    }
  }
  get chatHandle() { return this.handle; }
  attachView() {
    this.external = false;
    if (!this.disposed && !this.failed && this.handle && !this.polling) this.poll();
  }
  failExternal(error: string) { this.fail(new Error(error)); }
  ingest(records: any[]) {
      for (const record of records) {
        if (record.type === "response") {
          const pending = typeof record.id === "string" ? this.requests.get(record.id) : undefined;
          if (!pending || record.command !== pending.command || typeof record.success !== "boolean") throw new Error("Uncorrelated runtime response.");
          this.requests.delete(record.id as string);
          if (record.success) pending.resolve(record.data); else pending.reject(new Error(typeof record.error === "string" ? record.error : "Runtime request failed."));
        }
        // Session replacement replays historical messages as ordinary wire events. The
        // authoritative get_messages response below renders the final transcript once,
        // instead of animating the old conversation again. Interactions still arrive
        // during startup and must remain answerable.
        if (this.replaying && record.type !== "extension_ui_request" && record.type !== "extension_error") continue;
        if (record.type === "response") {
          continue;
        } else if (record.type === "desktop_gap") {
          // The native worker compacted an unread backlog. The turn continues; the
          // view is behind until the next settle reconciles from get_messages.
          this.gapPending = true;
          this.update({ gap: true });
        } else if (record.type === "extension_ui_request") {
          if (record.method === "setWidget" && typeof record.widgetKey === "string") {
            const widgets = { ...(this.snapshot.widgets ?? {}) };
            const lines = Array.isArray(record.widgetLines) ? record.widgetLines.filter((line: unknown): line is string => typeof line === "string") : undefined;
            if (lines?.length) widgets[record.widgetKey] = lines;
            else delete widgets[record.widgetKey];
            this.update({ widgets });
          } else if (record.method === "setStatus" && typeof record.statusKey === "string") {
            const statuses = { ...(this.snapshot.statuses ?? {}) };
            if (typeof record.statusText === "string" && record.statusText) statuses[record.statusKey] = record.statusText;
            else delete statuses[record.statusKey];
            this.update({ statuses });
          } else {
            if (typeof record.id === "string" && ["select", "confirm", "input", "editor"].includes(String(record.method))) {
              if (!this.dialogs.has(record.id)) {
                if (this.dialogs.size >= 64) throw new Error("Runtime exceeded the pending interaction limit.");
                this.dialogs.set(record.id, typeof record.timeout === "number" && Number.isFinite(record.timeout) ? Date.now() + Math.max(0, record.timeout) : null);
              }
            }
            this.dialog(record, this);
          }
        }
        else if (record.type === "extension_error") {
        const error = typeof record.error === "string" ? record.error : "A runtime extension failed.";
        // A replaced session can leave one extension holding its previous context. That
        // lifecycle race cannot change the transcript or the current session, so do not
        // surface it as a workspace failure and ask the user to retry a completed switch.
        if (/extension ctx is stale/iu.test(error)) continue;
        this.update({ error });
      }
        else this.update({ projection: projectEvent(this.snapshot.projection, record) });
      }
      // Reconcile only when the turn is over: history is authoritative then, and a
      // mid-turn get_messages would fight the live stream.
      if (this.gapPending && this.snapshot.projection.running === false && !this.replaying && this.handle) {
        this.gapPending = false;
        void this.refreshHistory()
          .then(() => this.update({ gap: false }))
          .catch(() => { /* Keep the notice; the next settle retries. */ this.gapPending = true; });
      }
  }
  tick() {
      const now = Date.now();
      const waitingForUser = this.dialogs.size > 0;
      for (const [id, deadline] of this.dialogs) if (deadline !== null && deadline <= now) this.dialogs.delete(id);
      // A person deciding a dialog is not a slow runtime; do not charge that time to the watchdog.
      if (waitingForUser) for (const pending of this.requests.values()) pending.deadline += now - this.lastPoll;
      this.lastPoll = now;
      for (const pending of this.requests.values()) if (now > pending.deadline) throw new Error("Jouzu did not answer for five minutes. The outcome is uncertain; no work was replayed.");
  }
  private poll = async () => {
    if (this.disposed || this.failed || !this.handle || this.polling) return;
    this.polling = true;
    try {
      const batch = await invoke<Poll>("chat_poll", { handle: this.handle });
      if (this.disposed || this.failed) return;
      this.ingest(batch.records);
      if (batch.closed) throw new Error(batch.error || "Runtime disconnected. The outcome may be incomplete; no work was replayed.");
      this.tick();
      this.polling = false;
      this.timer = setTimeout(this.poll, this.requests.size || this.dialogs.size ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    } catch (error) {
      this.polling = false;
      this.fail(error);
    }
  };
  private wakePoll() {
    if (this.disposed || this.failed || !this.handle || this.polling) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    void this.poll();
  }
  request(command: string, fields: WireObject = {}): Promise<unknown> {
    if (!this.handle || this.disposed || this.failed) return Promise.reject(new Error("Chat is not connected."));
    const id = `desktop-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { command, resolve, reject, deadline: Date.now() + RESPONSE_WATCHDOG });
      void invoke("chat_send", { handle: this.handle, request: { ...fields, type: command, id } })
        .then(() => this.wakePoll())
        .catch(error => { this.requests.delete(id); reject(new Error(String(error))); });
    });
  }
  private async readState(): Promise<Record<string, unknown>> {
    const state = await this.request("get_state");
    if (!object(state) || typeof state.sessionId !== "string" || typeof state.isStreaming !== "boolean") throw new Error("Runtime returned incompatible session state.");
    const detail = object(state.model) ? state.model : undefined;
    const model = detail && typeof detail.name === "string" && detail.name !== "unknown" ? detail.name : undefined;
    const modelProvider = detail && typeof detail.provider === "string" && detail.provider !== "unknown" ? detail.provider : undefined;
    const modelId = detail && typeof detail.id === "string" && detail.id !== "unknown" ? detail.id : undefined;
    this.update({
      sessionId: state.sessionId,
      sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : undefined,
      model,
      modelProvider,
      modelId,
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined,
    });
    return state;
  }
  async refreshHistory() {
    const state = await this.readState();
    let history: unknown;
    try {
      history = await this.request("get_messages");
    } catch (error) {
      // A transcript larger than the transport frame is a per-session limit, not a
      // reason to take the whole connection offline. Report it and stay reachable.
      this.update({ historyError: String(error).replace(/^Error:\s*/u, "") });
      return;
    }
    if (!object(history) || !Array.isArray(history.messages)) throw new Error("Runtime returned incompatible history.");
    const projection = historyProjection(history.messages);
    projection.running = state.isStreaming as boolean;
    const reconciled = projection.running ? projection : interruptUnfinishedTools(projection);
    this.update({ projection: reconciled, historyError: undefined });
  }
  /** Retry the transcript read that failed; the connection was never closed. */
  async retryHistory() { await this.refreshHistory(); }
  private async applyPreferredModel() {
    const preferred = this.preferredModel;
    if (!preferred) return;
    if (this.snapshot.modelProvider === preferred.provider && this.snapshot.modelId === preferred.id) return;
    try { await this.selectModel(preferred.provider, preferred.id); }
    catch {
      // A saved model may disappear from the catalog; fall back to the runtime default.
      this.preferredModel = undefined;
      writeModelPreference(undefined);
    }
  }
  private async changeSession(command: "new_session" | "switch_session", fields: WireObject = {}) {
    if (!this.snapshot.connected || this.snapshot.pending) throw new Error("Wait for the current request to be accepted.");
    this.replaying = true;
    this.update({ pending: true, error: null });
    try {
      const result = await this.request(command, fields);
      if (object(result) && result.cancelled === true) throw new Error("The runtime cancelled the conversation change.");
      // A resumed session owns its model for this view, but it must not overwrite the
      // user's saved preference for future new sessions.
      await this.refreshHistory();
      if (command === "new_session") await this.applyPreferredModel();
    } catch (error) { this.replaying = false; this.update({ error: String(error) }); throw error; }
    finally {
      // Replay suppression is only for the switch/refresh window. Leaving it set made a
      // resumed session stop consuming every live runtime event after the history loaded.
      this.replaying = false;
      this.update({ pending: false });
    }
  }
  newSession() { return this.changeSession("new_session"); }
  resumeSession(sessionPath: string) { return this.changeSession("switch_session", { sessionPath }); }
  /** Ask the runtime, not the event projection, whether it is processing. */
  async isStreaming(): Promise<boolean> {
    const state = await this.request("get_state");
    return object(state) && state.isStreaming === true;
  }
  /** Reopen the current session so extensions, skills, MCP servers and catalogs re-bind. */
  async reloadSession() {
    const sessionPath = this.snapshot.sessionFile;
    if (!sessionPath) throw new Error("There is no saved session to reload yet.");
    if (this.snapshot.pending || this.snapshot.projection.running) throw new Error("Wait for the current turn to settle before reloading.");
    await this.changeSession("switch_session", { sessionPath });
    await this.loadModels();
  }
  /** Extension commands such as /mcp are executed by the runtime without a user turn. */
  async runCommand(command: string) {
    if (!this.snapshot.connected) throw new Error("Chat is not connected.");
    if (this.snapshot.pending || this.snapshot.projection.running) throw new Error("Wait for the current turn to settle before running a command.");
    this.update({ pending: true, error: null });
    try { await this.request("prompt", { message: command }); }
    catch (error) { this.update({ error: String(error) }); throw error; }
    finally { this.update({ pending: false }); }
  }
  async sendOrSteer(message: string, images: readonly ChatImage[], running: boolean) {
    if (this.snapshot.pending) throw new Error("Wait for the current request to be accepted.");
    // A resumed history can keep replaying entries after switch_session and get_messages.
    // Stop suppressing once the user writes a new turn; from here events are live.
    this.replaying = false;
    this.update({ pending: true, error: null });
    try {
      await this.request(running ? "steer" : "prompt", { message, ...(images.length ? { images } : {}) });
    } catch (error) { this.update({ error: String(error) }); throw error; }
    finally { this.update({ pending: false }); }
  }
  clearError() { this.update({ error: null }); }
  async abort() {
    try { await this.request("clear_queue"); } catch { /* The queue may already be empty; abort still applies. */ }
    try { await this.request("abort"); } catch (error) { this.update({ error: String(error) }); }
  }
  /**
   * Compact a session without loading its transcript. Attaching for compact used
   * to call get_messages, and a large session's response exceeds the 32 MiB JSONL
   * frame limit before compact can run. switch_session loads the runtime side;
   * get_state is small; the view keeps the preview it already has.
   */
  async compactSession(sessionPath?: string) {
    if (!this.snapshot.connected || this.snapshot.pending || this.snapshot.projection.running) throw new Error("Wait for the current conversation to settle before compacting.");
    this.update({ pending: true, error: null });
    this.replaying = true;
    try {
      if (sessionPath && sessionPath !== this.snapshot.sessionFile) {
        const result = await this.request("switch_session", { sessionPath });
        if (object(result) && result.cancelled === true) throw new Error("The runtime cancelled the conversation change.");
        await this.readState();
      }
      // Compaction changes the runtime context, not the transcript this view already
      // holds. No get_messages here; the next open reads the compacted history.
      await this.request("compact");
    } catch (error) {
      this.update({ error: String(error) });
      throw error;
    } finally {
      this.replaying = false;
      this.update({ pending: false });
    }
  }
  async compact() { return this.compactSession(); }
  async exportHtml(outputPath: string) {
    if (!this.snapshot.connected) throw new Error("Chat is not connected.");
    await this.request("export_html", { outputPath });
  }
  async loadModels() {
    try {
      const [data, catalog] = await Promise.all([
        this.request("get_available_models"),
        invoke<{ models?: CatalogModel[] }>("model_catalog").catch(() => ({ models: [] })),
      ]);
      const catalogModels = object(catalog) && Array.isArray(catalog.models) ? catalog.models.filter(object) : [];
      const catalogFor = (id: string) => {
        const value = id.toLowerCase();
        return catalogModels.find(model => typeof model.id === "string" && (value === model.id.toLowerCase() || value.endsWith(`/${model.id.toLowerCase()}`)));
      };
      const models = object(data) && Array.isArray(data.models)
        ? data.models.flatMap(entry => {
          if (!object(entry) || typeof entry.provider !== "string" || typeof entry.id !== "string") return [];
          const runtimeCost = object(entry.cost) ? {
            input: typeof entry.cost.input === "number" ? entry.cost.input : undefined,
            output: typeof entry.cost.output === "number" ? entry.cost.output : undefined,
            cacheRead: typeof entry.cost.cacheRead === "number" ? entry.cost.cacheRead : undefined,
            cacheWrite: typeof entry.cost.cacheWrite === "number" ? entry.cost.cacheWrite : undefined,
          } : undefined;
          const catalogModel = catalogFor(entry.id);
          return [{
            provider: entry.provider,
            id: entry.id,
            name: typeof entry.name === "string" ? entry.name : entry.id,
            contextWindow: catalogModel?.contextWindow ?? (typeof entry.contextWindow === "number" ? entry.contextWindow : undefined),
            maxTokens: catalogModel?.maxTokens ?? (typeof entry.maxTokens === "number" ? entry.maxTokens : undefined),
            // The runtime projection uses zero as a placeholder. Show a price only
            // when the catalog has one, or a provider supplied a real non-zero cost.
            cost: catalogModel?.cost ?? (hasCost(runtimeCost) ? runtimeCost : undefined),
          }];
        })
        : [];
      this.update({ models });
    } catch (error) { this.update({ error: `Could not read the model list. ${String(error)}` }); }
    finally { this.update({ modelsLoaded: true }); }
  }
  async loadStats() {
    try {
      const data = await this.request("get_session_stats");
      this.update({ stats: object(data) ? data as SessionStats : undefined });
    } catch { /* Session counters are ancillary; chat remains usable. */ }
  }
  async selectModel(provider: string, id: string) {
    this.update({ error: null });
    try {
      const data = await this.request("set_model", { provider, modelId: id });
      const name = object(data) && typeof data.name === "string" ? data.name : this.snapshot.models?.find(model => model.provider === provider && model.id === id)?.name ?? id;
      this.preferredModel = { provider, id };
      writeModelPreference(this.preferredModel);
      this.update({ model: name, modelProvider: provider, modelId: id });
    } catch (error) { this.update({ error: String(error) }); throw error; }
  }
  private async loadThinkingLevels() {
    try {
      const data = await this.request("get_available_thinking_levels");
      const levels = object(data) && Array.isArray(data.levels) ? data.levels.filter((level): level is string => typeof level === "string") : [];
      this.update({ thinkingLevels: levels });
    } catch { /* Thinking levels are optional in the released runtime. */ }
  }
  async setThinkingLevel(level: string) {
    try { await this.request("set_thinking_level", { level }); this.update({ thinkingLevel: level }); }
    catch (error) { this.update({ error: String(error) }); }
  }
  async reply(id: string, fields: WireObject) {
    if (!this.handle || this.disposed || this.failed) throw new Error("Chat is not connected.");
    await invoke("chat_send", { handle: this.handle, request: { type: "extension_ui_response", id, ...fields } });
    this.dialogs.delete(id);
  }
  private fail(error: unknown) {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.clearStartupTimeout();
    this.update({ connected: false, transportReady: false, pending: false, error: String(error) });
    this.dialogs.clear();
    for (const request of this.requests.values()) request.reject(new Error(String(error)));
    this.requests.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.handle) void invoke("chat_stop", { handle: this.handle }).catch(() => {});
  }
  async close() {
    this.disposed = true;
    this.clearStartupTimeout();
    this.dialogs.clear();
    this.snapshot = { ...this.snapshot, transportReady: false, connected: false };
    if (this.timer) clearTimeout(this.timer);
    for (const request of this.requests.values()) request.reject(new Error("Conversation closed."));
    this.requests.clear();
    if (this.handle) await invoke("chat_stop", { handle: this.handle });
  }
}


