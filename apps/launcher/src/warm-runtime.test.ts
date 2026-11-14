import { describe, expect, it } from "vitest";
import { nextWarmView, warmBlocks } from "./warm-runtime";

describe("warm runtime view", () => {
  it("blocks loading until the host says how the warm-up stands", () => {
    expect(warmBlocks({ state: "unknown", since: null, error: null })).toBe(true);
    expect(warmBlocks({ state: "starting", since: 1, error: null })).toBe(true);
    expect(warmBlocks({ state: "ready", since: null, error: null })).toBe(false);
    expect(warmBlocks({ state: "off", since: null, error: null })).toBe(false);
  });

  it("keeps loading on a failed warm-up, with its reason, instead of letting the user into a chat that cannot answer", () => {
    const view = nextWarmView({ state: "starting", since: 1, error: null }, { state: "failed", error: "node missing" }, 5);
    expect(warmBlocks(view)).toBe(true);
    expect(view.error).toBe("node missing");
  });

  it("times a warm-up from when the host started it, not from when the window asked", () => {
    const first = nextWarmView({ state: "unknown", since: null, error: null }, { state: "starting", elapsedMs: 4000 }, 10_000);
    expect(first.since).toBe(6000);
    const later = nextWarmView(first, { state: "starting", elapsedMs: 9000 }, 15_500);
    expect(later.since).toBe(6000);
  });
});
