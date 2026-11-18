/**
 * The only interface the UI depends on. Platform implementations are siblings
 * (DesktopApi / WebApi / RemoteApi); components never import Tauri or fetch
 * host endpoints directly.
 *
 * See docs/adr/0009 and docs/contracts/jouzu-api-v1.md.
 */

export type Unsubscribe = () => void;

export interface ApiCapabilities {
  host: boolean;
  native: boolean;
  features: string[];
  scopes: string[];
}

export type ApiErrorCode =
  | "capability-unavailable"
  | "unauthorized"
  | "forbidden"
  | "prompt-forbidden"
  | "invalid-request"
  | "session-not-found"
  | "prompt-resolved"
  | "prompt-expired"
  | "runtime-unavailable"
  | "runtime-missing"
  | "runtime-error"
  | "runtime-timeout"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class CapabilityUnavailable extends ApiError {
  constructor(message = "This action is not available on this platform.") {
    super("capability-unavailable", message, false);
    this.name = "CapabilityUnavailable";
  }
}

export interface SessionSummary {
  sessionId: string | null;
  sessionPath: string | null;
  workspacePath: string;
  title: string;
  status: string;
  updatedAt?: string;
  running: boolean;
  pinned: boolean;
  archived: boolean;
  pendingApprovals?: number;
  pendingQuestions?: number;
  /** Messages the host holds for this session (waiting, held, or returned by Stop). */
  queued?: number;
  /** The host holds a failed message to retry. */
  hasFailedTurn?: boolean;
}

export interface SessionHandle {
  sessionId: string;
  workspacePath: string;
  sessionPath: string | null;
  status: string;
  cursor: number;
  /** The rest of the session's state at attach (model, queue, turn...), as `session.updated` carries it. */
  [field: string]: unknown;
}

export interface Attachment {
  name: string;
  mimeType: string;
  data?: string;
  id?: string;
  bytes?: number;
  path?: string;
}

export interface OutgoingMessage {
  clientMessageId: string;
  text: string;
  clientId?: string;
  attachments?: Attachment[];
}

export interface Receipt {
  messageId: string;
  receipt: string;
  /** The session was busy: the message waits in its queue until the runtime uses it. */
  waiting?: boolean;
}

export interface HistoryRow {
  cursor: number;
  id: string;
  kind: "user" | "assistant" | "tool" | string;
  text?: string;
  turnId?: string;
  createdAt?: string;
  attachments?: Attachment[];
  tool?: { name: string; callId: string; status: string };
  model?: string;
  provider?: string;
  usage?: unknown;
  args?: unknown;
  result?: unknown;
}

export interface HistoryPage {
  messages: HistoryRow[];
  nextBefore: number | null;
}

/** A page of a saved session's messages, read from its file (#20). */
export interface SavedMessagesPage {
  /** Runtime messages, oldest first. */
  messages: unknown[];
  /** Read the page before this one with `before: nextBefore`; null at the first message. */
  nextBefore: number | null;
  /** User messages before this page: the user turn it starts in. */
  turn: number;
}

export interface SessionTiming {
  modelMs: number;
  toolMs: number;
  turns: number;
  steps: number;
  outputTokens: number;
}

export interface Workspace {
  id: string;
  path: string;
  environment: { kind: string };
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  reasoning?: boolean;
  input?: string[];
}

export interface RuntimeStatus {
  hostVersion: string;
  runtimeHome: string;
  appVersion?: string | null;
  node: boolean;
  app: boolean;
  bash: boolean;
  git: boolean;
  terminal: boolean;
}

export interface Artifact {
  id: string;
  kind: string;
  mimeType: string;
  absolutePath?: string;
  createdAt?: string;
  source?: { sessionId?: string };
  [key: string]: unknown;
}

export interface ArtifactBody {
  record: Artifact;
  mimeType: string;
  data: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface EnvironmentEntry {
  name: string;
  value: string;
  enabled: boolean;
}

export interface SessionApi {
  list(): Promise<SessionSummary[]>;
  attach(workspacePath: string, sessionPath?: string): Promise<SessionHandle>;
  /** This client shows the session now; the host streams its content here again. */
  view?(sessionId: string): Promise<void>;
  /** The session as it stands now; `cursor` is the last event it includes. */
  snapshot?(sessionId: string): Promise<Record<string, unknown>>;
  history(sessionId: string, page?: { limit?: number; before?: number }): Promise<HistoryPage>;
  messages(sessionPath: string, page?: { limit?: number; before?: number }): Promise<SavedMessagesPage>;
  send(sessionId: string, message: OutgoingMessage): Promise<Receipt>;
  interrupt(sessionId: string): Promise<void>;
  cancel(sessionId: string, clientMessageId: string): Promise<void>;
  queue(sessionId: string, action: "continue" | "discard" | "retry"): Promise<void>;
  stop(sessionId: string): Promise<void>;
  update(sessionPath: string, change: { pinned?: boolean; archived?: boolean; title?: string }): Promise<SessionSummary | unknown>;
  /** Copy a saved session through user turn `turn` (1 = the first user message) into a new one. */
  branch(sessionPath: string, turn: number): Promise<string>;
  recover(sessionPath: string): Promise<string | null>;
  /** Replace images the provider refuses with placeholders; the original is kept. */
  sanitizeImages(sessionPath: string): Promise<{ removed: number; backup: string }>;
  /** An image of a user message in the session's history, by the id its history row gives it. */
  attachment?(sessionId: string, attachmentId: string): Promise<{ mimeType: string; data: string }>;
  timing(sessionPath: string): Promise<SessionTiming>;
  flowReports(sessionPath: string): Promise<Array<{ kind: string; text: string }>>;
}

export interface PromptApi {
  approve(approvalId: string, decision: string): Promise<void>;
  answer(questionId: string, answers: Record<string, string>): Promise<void>;
}

/** The runtime the host starts ahead of need (see the host's warm pool). */
export interface WarmRuntime {
  state: "off" | "starting" | "ready" | "failed";
  /** Milliseconds since this warm-up started. */
  elapsedMs?: number | null;
  readyMs?: number | null;
  error?: string | null;
  workspace?: string | null;
}

export type TimingMark = "ui.boot" | "loading.ready" | "message.shown" | "first_output.shown" | "stop.shown";

export interface RuntimeApi {
  status(): Promise<RuntimeStatus>;
  /** Warm the runtime for this workspace; returns the warm-up state. */
  warm(workspacePath: string): Promise<WarmRuntime>;
  /** The warm-up state, waiting up to `waitMs` for it to settle. */
  warmState(waitMs: number): Promise<WarmRuntime>;
  /** Record a moment the user saw (host.log `timing.ui`). Best effort: never throws. */
  mark?(mark: TimingMark, ids?: { sessionId?: string; clientMessageId?: string }): void;
  components(): Promise<Record<string, unknown>>;
  diagnostics(): Promise<unknown | null>;
}

export interface WorkspaceApi {
  list(): Promise<Workspace[]>;
  add(paths: string[]): Promise<Workspace[]>;
  forget(id: string): Promise<Workspace[]>;
}

export interface ModelApi {
  list(sessionId: string): Promise<Model[]>;
  select(sessionId: string, provider: string, model: string): Promise<void>;
  thinking(sessionId: string, level: string): Promise<void>;
}

export interface ToolsApi {
  settings(): Promise<{ path: string; exists: boolean; settings: Record<string, unknown> }>;
  save(image: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Each provider says whether it can generate images now, and why not; `models` comes with a usable one. */
  providers(): Promise<{ providers: Array<{ id: string; label: string; available?: boolean; reason?: string; models?: unknown }> }>;
  models(provider: string): Promise<{ models: unknown }>;
}

export interface McpApi {
  servers(): Promise<{ path: string; exists: boolean; servers: Array<{ name: string; transport: string; target?: string; description?: string; exposure?: string }> }>;
}

export interface CommandApi {
  run(sessionId: string, command: string): Promise<void>;
  /** Usage counters; null while the session has no runtime yet. */
  stats(sessionId: string): Promise<unknown>;
  compact(sessionId: string): Promise<void>;
  exportHtml(sessionId: string, outputPath: string): Promise<void>;
  /** Re-read the session's own saved file; the host knows which file that is. */
  reload(sessionId: string): Promise<void>;
}

export interface ArtifactApi {
  list(options?: { kind?: string; sessionId?: string }): Promise<Artifact[]>;
  read(id: string): Promise<ArtifactBody>;
  delete(id: string): Promise<void>;
  counts(): Promise<Record<string, number>>;
}

export interface FileApi {
  list(path: string): Promise<FileEntry[]>;
  reveal(path: string): Promise<void>;
  /** Read one workspace file (a dropped image) as base64. */
  readFile(path: string): Promise<{ name: string; mimeType: string; data: string }>;
  /** Bounded workspace snapshot for the turn summary. */
  snapshot(path: string): Promise<{ files: Array<{ path: string; size: number; modified: number }>; truncated: boolean }>;
}

export type WebAccessMode = "off" | "local" | "networks";

export interface WebAccessNetwork {
  name: string;
  address: string;
  kind: "lan" | "tailnet";
  enabled: boolean;
  /** Set while this network is being served. */
  url: string | null;
  error: string | null;
}

export interface WebAccessDevice {
  id: string;
  name: string;
  network: string;
  createdAt: string;
  lastSeen: string | null;
}

/** Who may use the Jouzu web UI besides the desktop window (issue #91). */
export interface WebAccessState {
  mode: WebAccessMode;
  port: number | null;
  /** Whether web traffic is encrypted; plain HTTP today. */
  secure: boolean;
  localUrl: string | null;
  localError: string | null;
  networks: WebAccessNetwork[];
  /** Enabled networks that are not on this computer right now. */
  unavailableNetworks: string[];
  devices: WebAccessDevice[];
  pairing: boolean;
}

export interface WebAccessPairing {
  code: string;
  expiresInSeconds: number;
  links: Array<{ network: string; url: string }>;
}

export interface SettingsApi {
  environment: {
    /** Saving goes through the configuration queue (`environment`). */
    read(): Promise<EnvironmentEntry[]>;
  };
  /** Only the desktop window may manage web access; web clients get `forbidden`. */
  webAccess: {
    read(): Promise<WebAccessState>;
    update(scope: { mode: WebAccessMode; networks: string[] }): Promise<WebAccessState>;
    pair(): Promise<WebAccessPairing>;
    cancelPairing(): Promise<void>;
    /** Remove one paired device, or every device when `id` is omitted. */
    revoke(id?: string): Promise<WebAccessState>;
  };
  control(request: unknown): Promise<unknown>;
}

export interface NativeApi {
  confirm(options: { message: string; title?: string }): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  /** Ask where to save a file; null when the user cancels. */
  saveFile(options: { title: string; defaultPath: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  /**
   * Files dropped onto the window. `position` is in CSS pixels. Returns an
   * unsubscribe function; a shell without native drag and drop never calls back.
   */
  onFileDrop(listener: (event: { type: "over" | "drop" | "leave"; paths: string[]; position?: { x: number; y: number } }) => void): () => void;
  reveal(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  terminal(path?: string): Promise<void>;
  installTerminal(): Promise<void>;
  updater: {
    check(): Promise<unknown>;
    install(): Promise<void>;
  };
}

export interface ApiEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
  /** Global event-hub sequence; absent on legacy per-session streams. */
  seq?: number;
  sessionId?: string;
  sessionSeq?: number;
}

export abstract class JouzuApi {
  abstract readonly capabilities: ApiCapabilities;
  abstract readonly sessions: SessionApi;
  abstract readonly prompts: PromptApi;
  abstract readonly runtime: RuntimeApi;
  abstract readonly workspaces: WorkspaceApi;
  abstract readonly models: ModelApi;
  abstract readonly tools: ToolsApi;
  abstract readonly mcp: McpApi;
  abstract readonly commands: CommandApi;
  abstract readonly artifacts: ArtifactApi;
  abstract readonly files: FileApi;
  abstract readonly settings: SettingsApi;
  abstract readonly native: NativeApi;

  abstract start(): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract subscribe(
    sessionId: string,
    clientId: string,
    capabilities: string[],
    cursor: number | undefined,
    onEvent: (event: ApiEvent) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe;
}


