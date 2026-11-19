/** A crash record the app wrote under its managed root. */
export interface CrashRecord { path: string; time: number; message: string; location: string; version: string }
/** What the System section reads from the installation: where logs live, and the crash records. */
export interface Diagnostics { logs: string; crashes: CrashRecord[] }

/**
 * Accept a diagnostics answer only when it has the shape this interface renders. A build without the
 * command, or one answering something else, leaves the section empty instead of breaking the window.
 */
export function parseDiagnostics(value: unknown): Diagnostics | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { logs?: unknown; crashes?: unknown };
  if (typeof candidate.logs !== "string" || !Array.isArray(candidate.crashes)) return null;
  const crashes = candidate.crashes.filter((record): record is CrashRecord => {
    if (typeof record !== "object" || record === null) return false;
    const entry = record as Record<string, unknown>;
    return typeof entry.path === "string" && typeof entry.message === "string" && typeof entry.time === "number";
  });
  return { logs: candidate.logs, crashes };
}
