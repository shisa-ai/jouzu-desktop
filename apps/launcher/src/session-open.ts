import type { SessionSummary } from "./api/jouzu-api";

/**
 * A session the host is working on must be opened live, through the host:
 * its partial reply, its approval or question, and its Stop exist only there.
 * Reading the saved file instead would show none of them and leave the user
 * with nothing to answer. Sessions at rest open from the saved file.
 */
const ACTIVE = new Set(["starting", "running", "waiting_approval", "waiting_question", "recovering"]);

export function opensLive(summary: Pick<SessionSummary, "status" | "running"> | undefined): boolean {
  return !!summary && (summary.running || ACTIVE.has(summary.status));
}
