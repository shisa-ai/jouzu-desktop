import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./secure-context";
import { InputError } from "./input-error";

/**
 * File actions for paths that appear in the transcript (0057). Revealing is a
 * native command so the path policy cannot be bypassed from the webview, and it
 * never launches file contents.
 */

export type RevealFailure = "not-absolute" | "not-found" | "not-a-file" | "outside-workspace" | "reveal-failed";

const MESSAGES: Record<RevealFailure, string> = {
  "not-absolute": "That path is relative and has no workspace.",
  "not-found": "File not found",
  "not-a-file": "Not a file",
  "outside-workspace": "Outside the workspace",
  "reveal-failed": "Could not reveal",
};

export function revealMessage(reason: string | undefined): string {
  return MESSAGES[(reason ?? "") as RevealFailure] ?? "Could not reveal";
}

function failureReason(error: unknown): RevealFailure {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  // The native command answers with the failure's code itself (attachments.rs reveal_target).
  return text in MESSAGES ? text as RevealFailure : "reveal-failed";
}

/** One in-flight reveal per path, so a double click cannot spawn two shells. */
const pending = new Set<string>();

export async function revealPath(path: string, workspace?: string): Promise<void> {
  if (pending.has(path)) return;
  pending.add(path);
  try {
    await invoke("reveal_path", workspace ? { path, workspace } : { path });
  } catch (error) {
    const reason = failureReason(error);
    throw new InputError(`reveal-${reason.replace(/^reveal-/u, "")}`, revealMessage(reason));
  } finally {
    pending.delete(path);
  }
}

export async function copyPath(path: string): Promise<boolean> {
  try {
    await copyText(path);
    return true;
  } catch {
    return false;
  }
}