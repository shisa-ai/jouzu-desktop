/**
 * Runtime errors that a user cannot act on must never reach the screen verbatim.
 * The runtime's Flow submission store is per session and never reclaimed, so a
 * capacity failure can only be answered by starting a new session.
 */
export const CAPACITY_MESSAGE = "This session has used up its stored message budget, so it cannot accept another message. Start a new session to keep working.";

export function isCapacityError(message: string | null | undefined): boolean {
  return !!message && /Submission retention limit reached/iu.test(message);
}

/** Flow's per-session submission store is full; `/flow clear` is the recovery. */
export function isFlowHistoryError(message: string | null | undefined): boolean {
  return !!message && /Request history is full/iu.test(message);
}

export function humanizeRuntimeError(message: string): string {
  return isCapacityError(message) ? CAPACITY_MESSAGE : message;
}

const CODE_MESSAGES: Partial<Record<string, string>> = {
  "runtime-unavailable": "The model runtime is not available right now. Try again in a moment.",
  "runtime-timeout": "The model runtime did not respond in time. Try again.",
  "session-not-found": "This session is no longer open. Select it in the sidebar to reopen it.",
  unauthorized: "This window lost its connection to Jouzu. Reload the app.",
  forbidden: "This window is not allowed to do that. Reload the app.",
  "prompt-forbidden": "This window is not allowed to answer requests. Reload the app.",
  "prompt-resolved": "This request was already answered.",
  "prompt-expired": "This request expired before it was answered.",
};

/**
 * The one place that turns a thrown value into text a user reads. Host errors
 * carry a code; a known code gets a fixed sentence, anything else keeps the
 * host's message without the JavaScript class prefix.
 */
export function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CODE_MESSAGES[code]) return CODE_MESSAGES[code]!;
  }
  if (error instanceof TypeError && /fetch|network/iu.test(error.message)) return "Cannot reach Jouzu. Check that the app is still running.";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.replace(/^(?:Api)?Error:\s*/u, "").trim();
  return humanizeRuntimeError(text || "Something went wrong.");
}

/** What a person reads, and the raw text kept behind "Details". */
export interface Explained { text: string; details?: string }

/** A model or provider refused an image that is part of the session. */
export function isImageRefused(message: string | null | undefined): boolean {
  return !!message && /image[^.]{0,80}(must be larger|too small|minimum|below)|(must be larger|minimum)[^.]{0,40}image/iu.test(message);
}

function rawText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^(?:Api)?Error:\s*/u, "").trim();
}

const sentence = (text: string) => /[.!?。]$/u.test(text) ? text : `${text}.`;

/**
 * Turn a failure into one plain sentence that says what did not happen, with the
 * raw text kept for "Details" (and host.log). Known failures get a sentence that
 * says what to do; a request the host refused as invalid says why, since that
 * reason is written for people; anything else says what failed, never shows
 * the technical message itself.
 */
export function explainError(error: unknown, failed: string): Explained {
  const raw = rawText(error);
  const details = raw && raw !== failed ? raw : undefined;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CODE_MESSAGES[code]) return { text: CODE_MESSAGES[code]!, details };
    if (code === "invalid-request" && raw) return { text: `${sentence(failed)} ${sentence(raw)}`, details: undefined };
  }
  if (error instanceof TypeError && /fetch|network/iu.test(error.message)) return { text: "Cannot reach Jouzu. Check that the app is still running.", details };
  if (isCapacityError(raw)) return { text: CAPACITY_MESSAGE, details };
  if (isFlowHistoryError(raw)) return { text: "Flow request history is full. Clear it before sending again.", details };
  if (isImageRefused(raw)) return { text: "The model refuses an image in this session, so every request fails.", details };
  return { text: sentence(failed), details };
}
