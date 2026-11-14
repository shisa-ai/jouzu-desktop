import type { ChatProjection } from "./chat-projection";
import type { TextGuardMode } from "./session-notices";

/** One id per page load: handles from an older page are released by the host. */
export const pageGeneration = globalThis.crypto.randomUUID();

export interface ChatImage { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }
export interface ChatModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  thinkingLevels?: string[];
  /** False when the runtime cannot use this model now; `unavailableReason` says why. */
  available?: boolean;
  unavailableReason?: string | null;
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

export function readModelPreference(): { provider: string; id: string } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(MODEL_PREFERENCE_KEY) ?? "null");
    return value && typeof value.provider === "string" && typeof value.id === "string" ? value : undefined;
  } catch { return undefined; }
}
export function writeModelPreference(value: { provider: string; id: string } | undefined) {
  try {
    if (value) localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(value));
    else localStorage.removeItem(MODEL_PREFERENCE_KEY);
  } catch { /* A webview without storage keeps the selection for this session only. */ }
}

/** The host's view of the turn in progress (`session.updated.activeTurn`). */
/** What the running turn is doing now, as the host reports it. */
export interface TurnStep {
  n: number;
  state: string;
  since?: number;
  tools: Array<{ id: string; name: string }>;
  retry?: { attempt?: number; maxAttempts?: number; error?: string };
}
export interface ActiveTurn {
  turnId: string;
  clientMessageId?: string;
  phase: string;
  startedAt?: number;
  step?: TurnStep;
}
/** A message waiting for the running turn (steer) or, after Stop, for Continue. */
export interface QueuedMessage { clientMessageId: string; text: string; state: string; images: number }
/** An approval or question the host is waiting on; rendered from host data only. */
export interface PendingPrompt {
  kind: "approval" | "question";
  id: string;
  title: string;
  message: string;
  /** Exact option strings the host accepts; sent back unchanged. */
  options: string[];
  /** For a question: the host's item id the answer is keyed by. */
  itemId?: string;
  expiresAt?: number;
}
/**
 * A message the user sent that the host has not confirmed yet. It is the only
 * UI-owned piece of session state and is keyed by clientMessageId.
 */
export interface OutboxItem {
  clientMessageId: string;
  text: string;
  images: ChatImage[];
  state: "sending" | "failed";
  error?: string;
  at: number;
}

export interface ChatSnapshot {
  projection: ChatProjection;
  connected: boolean;
  /** True while one of the user's own messages has not been confirmed by the host. */
  pending: boolean;
  /** The last error for this session, shown in the banner area. */
  error: string | null;
  /** The session is open but its transcript could not be read. */
  historyError?: string;
  sessionId?: string;
  sessionFile?: string;
  /** Host status: pending, starting, idle, running, waiting_approval, waiting_question, recovering, stopped, error. */
  status?: string;
  /** Host-owned; null when no turn is in progress. The only source of "running". */
  activeTurn?: ActiveTurn | null;
  prompts?: PendingPrompt[];
  outbox?: OutboxItem[];
  model?: string;
  modelProvider?: string;
  modelId?: string;
  models?: ChatModel[];
  modelsLoaded?: boolean;
  stats?: SessionStats;
  thinkingLevel?: string;
  thinkingLevels?: string[];
  /** Host-measured time from a prompt reaching the runtime to its first output. */
  firstOutput?: { turns: number; avgMs: number | null; lastMs: number | null };
  queue?: QueuedMessage[];
  failedTurn?: { clientMessageId: string; text: string } | null;
  /** Extension widgets and status lines, as the host last reported them. */
  widgets?: Record<string, string[]>;
  statuses?: Record<string, string>;
  /** Flow control is holding input; the UI offers the controls that release it. */
  flowHold?: { text: string; paused: boolean } | null;
  /** TextGuard's mode as last confirmed by the runtime, and any content it withheld. */
  textguard?: { mode?: TextGuardMode; alert?: string };
  /** The latest transient runtime notice (command replies and the like). */
  notice?: { id: number; text: string; level: "info" | "warning" | "error" } | null;
}
