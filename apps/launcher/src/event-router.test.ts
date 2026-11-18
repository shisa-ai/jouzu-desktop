import { describe, expect, it, vi } from "vitest";
import { eventRouter } from "./event-router";
import type { HostClient } from "./api/host-client";
import type { ApiEvent } from "./api/jouzu-api";

describe("event router", () => {
  it("delivers global events and advances the resume sequence", () => {
    let emit: ((event: ApiEvent) => void) | undefined;
    const subscribeEvents = vi.fn((_clientId: string, _after: number, onEvent: (event: ApiEvent) => void) => {
      emit = onEvent;
      return () => {};
    });
    eventRouter.start({ clientId: "router-test", subscribeEvents } as unknown as HostClient);
    const seen: ApiEvent[] = [];
    const unsubscribe = eventRouter.subscribe(event => seen.push(event));
    emit?.({ id: 7, seq: 7, sessionId: "s1", event: "session.updated", data: { status: "idle" } });
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe("s1");
    unsubscribe();
  });

  it("says it is reconnecting from a dropped stream until the next one opens", () => {
    vi.useFakeTimers();
    const opens: Array<() => void> = [];
    const errors: Array<(error: unknown) => void> = [];
    const subscribeEvents = vi.fn((_clientId: string, _after: number, _onEvent: unknown, onError: (error: unknown) => void, onOpen: () => void) => {
      errors.push(onError);
      opens.push(onOpen);
      return () => {};
    });
    eventRouter.start({ clientId: "router-test-2", subscribeEvents } as unknown as HostClient);
    opens.at(-1)?.();
    const changes = vi.fn();
    const stop = eventRouter.onStatus(changes);
    expect(eventRouter.reconnecting).toBe(false);
    errors.at(-1)?.(new Error("Event stream ended"));
    expect(eventRouter.reconnecting).toBe(true);
    vi.advanceTimersByTime(1000);
    opens.at(-1)?.();
    expect(eventRouter.reconnecting).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });
});
