/** How often the app asks again while it stays open, and how old a previous answer has to be
 * before returning to the window is worth another question. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FOCUS_STALE_MS = 30 * 60 * 1000;

interface WindowLike {
  addEventListener(name: string, listener: () => void): void;
  removeEventListener(name: string, listener: () => void): void;
}

export interface UpdateSchedule {
  /** The check that runs when the app starts. */
  initial(): void;
  /** A check that runs while the app stays open, without showing it in the interface. */
  periodic(): void;
  /** A check when the window is focused again, only when the last answer is old enough. */
  focused(): void;
}

/**
 * An app that stays open for days would otherwise never hear about a release published after it
 * started, so a periodic check and a return-to-window check both exist. The caller decides what a
 * silent check is: it must not move the interface while it runs.
 */
export function createUpdateSchedule(
  check: (silent: boolean) => void,
  options: { now?: () => number; freshMs?: number } = {},
): UpdateSchedule {
  const now = options.now ?? Date.now;
  const freshMs = options.freshMs ?? FOCUS_STALE_MS;
  let last = 0;
  return {
    initial() { last = now(); check(false); },
    periodic() { last = now(); check(true); },
    focused() { const at = now(); if (at - last >= freshMs) { last = at; check(true); } },
  };
}

/** Run the schedule until the returned function stops it. */
export function startUpdateChecks(
  schedule: UpdateSchedule,
  options: { windowRef?: WindowLike; intervalMs?: number } = {},
): () => void {
  const target = options.windowRef ?? (window as unknown as WindowLike);
  schedule.initial();
  const timer = setInterval(() => schedule.periodic(), options.intervalMs ?? CHECK_INTERVAL_MS);
  const listener = () => schedule.focused();
  target.addEventListener("focus", listener);
  return () => { clearInterval(timer); target.removeEventListener("focus", listener); };
}
