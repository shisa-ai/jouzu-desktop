/**
 * The runtime the host starts ahead of need.
 *
 * Starting a runtime takes tens of seconds on a busy machine. The host does it in
 * the background; the window's loading screen waits for it, so the cost lands
 * before the user acts instead of on their first message.
 */
import { useEffect, useState } from "react";
import type { RuntimeApi, WarmRuntime } from "./api/jouzu-api";

export interface WarmView {
  state: WarmRuntime["state"] | "unknown";
  /** When this client saw the warm-up start (ms since epoch); drives the timer. */
  since: number | null;
  error: string | null;
}

const initial: WarmView = { state: "unknown", since: null, error: null };

/**
 * Whether the loading screen holds. It holds while the runtime starts, and on a
 * failure too: the screen then shows why and offers a retry, instead of letting
 * the user into a chat whose first message would stall or fail.
 */
export function warmBlocks(view: WarmView): boolean {
  return view.state === "unknown" || view.state === "starting" || view.state === "failed";
}

/** Fold one host answer into the view. */
export function nextWarmView(previous: WarmView, answer: WarmRuntime, now: number): WarmView {
  if (answer.state === "starting") {
    const elapsed = typeof answer.elapsedMs === "number" ? answer.elapsedMs : 0;
    return { state: "starting", since: previous.state === "starting" && previous.since ? previous.since : now - elapsed, error: null };
  }
  return { state: answer.state, since: null, error: answer.state === "failed" ? answer.error ?? "The runtime could not start." : null };
}

/**
 * Aim the host's warm runtime at `workspace` and follow it until it settles.
 * A host without the endpoint (older build) reports "off", which blocks nothing.
 */
export function useWarmRuntime(runtime: RuntimeApi | undefined, workspace: string | null): [WarmView, () => void] {
  const [view, setView] = useState<WarmView>(initial);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!runtime || !workspace) { setView({ state: "off", since: null, error: null }); return; }
    let cancelled = false;
    setView(initial);
    void (async () => {
      try {
        let answer = await runtime.warm(workspace);
        let current = nextWarmView(initial, answer, Date.now());
        if (!cancelled) setView(current);
        while (!cancelled && answer.state === "starting") {
          answer = await runtime.warmState(5000);
          current = nextWarmView(current, answer, Date.now());
          if (!cancelled) setView(current);
        }
      } catch {
        if (!cancelled) setView({ state: "off", since: null, error: null });
      }
    })();
    return () => { cancelled = true; };
  }, [runtime, workspace, attempt]);
  return [view, () => setAttempt(value => value + 1)];
}
