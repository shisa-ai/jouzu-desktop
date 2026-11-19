import type { SessionSummary } from "./api/jouzu-api";

/**
 * A session the host is working on, or holds something for, must be opened
 * live, through the host: its partial reply, its approval or question, its Stop,
 * the messages it holds (waiting, or returned by Stop) and a failed message to
 * retry exist only there. Reading the saved file instead would show none of them
 * and leave the user with nothing to answer. Sessions at rest open from the file.
 */
const ACTIVE = new Set(["starting", "running", "waiting_approval", "waiting_question", "recovering"]);

export function opensLive(summary: Pick<SessionSummary, "status" | "running" | "queued" | "hasFailedTurn"> | undefined): boolean {
  return !!summary && (summary.running || ACTIVE.has(summary.status) || (summary.queued ?? 0) > 0 || summary.hasFailedTurn === true);
}

/** A session as the session list shows it, with what decides how it opens. */
export interface SessionRow {
  path: string;
  title: string;
  workspace: string;
  updated: number;
  pinned: boolean;
  archived: boolean;
  running: boolean;
  status: string;
  queued?: number;
  hasFailedTurn?: boolean;
}

/** The list row for a host session entry, or null for one that is not listed. */
export function sessionRow(value: SessionSummary): SessionRow | null {
  if (!value.sessionPath) return null;
  const title = value.title?.trim() ?? "";
  const fileId = value.sessionPath.split(/[\\/]/u).at(-1)?.replace(/\.jsonl$/u, "") ?? "";
  // Empty page-load sessions can come back from the persisted index with the
  // file id as a title. That is not a user-facing title.
  if (!title || title === fileId) return null;
  const parsed = value.updatedAt ? Date.parse(value.updatedAt) : NaN;
  const updated = Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : Date.now() / 1000;
  return {
    path: value.sessionPath,
    title,
    workspace: value.workspacePath,
    updated,
    pinned: value.pinned,
    archived: value.archived,
    running: value.running,
    status: value.status,
    queued: value.queued,
    hasFailedTurn: value.hasFailedTurn,
  };
}
