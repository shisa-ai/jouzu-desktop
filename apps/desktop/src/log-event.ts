import { invoke } from "@tauri-apps/api/core";

/**
 * One line about work no command sees, the app's own update above all, and about a check that
 * runs silently. Diagnostics never fail the operation they describe, so a refused call is dropped.
 */
export function logEvent(message: string): void {
  void invoke("log_event", { message }).catch(() => {});
}
