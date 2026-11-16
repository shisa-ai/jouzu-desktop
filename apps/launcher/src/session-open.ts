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
