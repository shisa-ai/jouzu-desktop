import { describe, it, expect, vi, afterEach } from "vitest";
import { CHECK_INTERVAL_MS, FOCUS_STALE_MS, createUpdateSchedule, startUpdateChecks } from "./update-schedule";

function fakeWindow() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    addEventListener: (name: string, listener: () => void) => { (listeners[name] ??= []).push(listener); },
    removeEventListener: (name: string, listener: () => void) => { listeners[name] = (listeners[name] ?? []).filter(item => item !== listener); },
    fire: (name: string) => { for (const listener of [...(listeners[name] ?? [])]) listener(); },
    count: (name: string) => (listeners[name] ?? []).length,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("checks while the app stays open", () => {
  it("runs at startup, on the interval, and on return only when the answer is old", () => {
    let clock = 1_000_000;
    const calls: boolean[] = [];
    const schedule = createUpdateSchedule(silent => calls.push(silent), { now: () => clock, freshMs: FOCUS_STALE_MS });

    schedule.initial();
    expect(calls).toEqual([false]);

    clock += 60_000;
    schedule.focused();
    expect(calls).toEqual([false]);

    clock += FOCUS_STALE_MS;
    schedule.focused();
    expect(calls).toEqual([false, true]);

    schedule.periodic();
    expect(calls).toEqual([false, true, true]);
  });

  it("starts the timer and the focus listener, and stops both", () => {
    vi.useFakeTimers();
    const target = fakeWindow();
    const calls: boolean[] = [];
    const stop = startUpdateChecks(createUpdateSchedule(silent => calls.push(silent)), { windowRef: target });

    expect(calls).toEqual([false]);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(calls).toEqual([false, true]);
    target.fire("focus");
    expect(calls).toEqual([false, true]);

    stop();
    expect(target.count("focus")).toBe(0);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(calls).toEqual([false, true]);
  });
});
