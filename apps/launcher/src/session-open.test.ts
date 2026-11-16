import { describe, expect, it } from "vitest";
import { opensLive } from "./session-open";

describe("opensLive", () => {
  it("opens a session waiting for an approval or an answer live", () => {
    expect(opensLive({ status: "waiting_approval", running: false })).toBe(true);
    expect(opensLive({ status: "waiting_question", running: false })).toBe(true);
  });

  it("opens running, starting and recovering sessions live", () => {
    expect(opensLive({ status: "running", running: true })).toBe(true);
    expect(opensLive({ status: "starting", running: false })).toBe(true);
    expect(opensLive({ status: "recovering", running: false })).toBe(true);
  });

  it("opens an idle session live when the host holds messages or a failed message for it", () => {
    expect(opensLive({ status: "idle", running: false, queued: 1 })).toBe(true);
    expect(opensLive({ status: "idle", running: false, hasFailedTurn: true })).toBe(true);
    expect(opensLive({ status: "idle", running: false, queued: 0, hasFailedTurn: false })).toBe(false);
  });

  it("opens sessions at rest from the saved file", () => {
    expect(opensLive({ status: "idle", running: false })).toBe(false);
    expect(opensLive({ status: "stopped", running: false })).toBe(false);
    expect(opensLive(undefined)).toBe(false);
  });
});
