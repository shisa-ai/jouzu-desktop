import type { ImageAttachment } from "./chat-attachments";

/** Text and attachments a composer holds for one workspace + session key. */
export interface Draft { text: string; attachments: ImageAttachment[] }

const PREFIX = "jouzu.draft.v1:";
const WRITE_DELAY_MS = 200;
const memory = new Map<string, Draft>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();

/** `workspace::session`, or `workspace::new` for the new-session slot. */
export function draftKey(workspacePath: string, sessionPath: string | null): string {
  return `${normalize(workspacePath)}::${sessionPath ? normalize(sessionPath) : "new"}`;
}

function storageKey(key: string): string {
  return `${PREFIX}${key}`;
}

function flush(key: string): void {
  timers.delete(key);
  const draft = memory.get(key);
  if (!draft) return;
  try {
    // Attachments stay in memory: a file's bytes do not belong in localStorage.
    if (draft.text) localStorage.setItem(storageKey(key), JSON.stringify({ text: draft.text }));
    else localStorage.removeItem(storageKey(key));
  } catch {
    // Unavailable or full storage keeps the draft for this run and never fails a send.
  }
}

/** Memory first, then storage; a stored draft has no attachments. */
export function readDraft(key: string): Draft | undefined {
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    if (!value || typeof value.text !== "string") return undefined;
    const draft = { text: value.text, attachments: [] };
    memory.set(key, draft);
    return draft;
  } catch {
    return undefined;
  }
}

/** Memory now, localStorage after the debounce; a pending write is replaced. */
export function writeDraft(key: string, draft: Draft): void {
  memory.set(key, { text: draft.text, attachments: [...draft.attachments] });
  const pending = timers.get(key);
  if (pending) clearTimeout(pending);
  timers.set(key, setTimeout(() => flush(key), WRITE_DELAY_MS));
}

export function clearDraft(key: string): void {
  const pending = timers.get(key);
  if (pending) clearTimeout(pending);
  timers.delete(key);
  memory.delete(key);
  try { localStorage.removeItem(storageKey(key)); } catch { /* Same as a failed write. */ }
}
