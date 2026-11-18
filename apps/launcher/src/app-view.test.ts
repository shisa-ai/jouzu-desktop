import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "./api/host-client";
import { configFailure, configPending, configureAppView, currentAppView, receiveAppViewForTest, runConfig, setAppViewForTest, type AppView } from "./app-view";

const settings = { schemaVersion: 1, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
const snapshot = (revision: number, config: Partial<AppView["config"]> = {}, value: unknown = settings) => ({
  revision,
  config: { running: null, queued: [], lastResult: {}, ...config },
  settings: value,
});
const result = (operationId: string, ok: boolean, finishedAt = "2026-11-18T00:00:00.000Z", code: string | null = ok ? null : "config-failed") =>
  ({ operationId, ok, code, params: {}, text: ok ? null : "failed", finishedAt });

describe("app view", () => {
  it("keeps only the newest snapshot", () => {
    setAppViewForTest(null);
    receiveAppViewForTest(snapshot(3));
    receiveAppViewForTest(snapshot(2, { queued: [{ operationId: "old", kind: "status", position: 0 }] }));
    expect(currentAppView()?.revision).toBe(3);
    expect(currentAppView()?.config.queued).toEqual([]);
  });

  it("keeps the operations readable when the settings are not", () => {
    setAppViewForTest(null);
    receiveAppViewForTest(snapshot(1, { lastResult: { environment: result("op-1", true) } }, { schemaVersion: 2 }));
    expect(currentAppView()?.settings).toBeNull();
    expect(currentAppView()?.config.lastResult.environment?.ok).toBe(true);
  });

  it("resolves a command with its own result, not an older one of the same kind", async () => {
    setAppViewForTest(null);
    const host = { configEnqueue: vi.fn(async () => ({ operationId: "op-2", position: 0 })), appView: vi.fn(async () => snapshot(0)) };
    configureAppView(host as unknown as HostClient);
    receiveAppViewForTest(snapshot(10, { lastResult: { "provider-key": result("op-1", true) } }));
    const pending = runConfig("provider-key", { provider: "openai", token: "k" });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    receiveAppViewForTest(snapshot(11, { running: { operationId: "op-2", kind: "provider-key", startedAt: "" } }));
    await Promise.resolve();
    expect(settled).toBe(false);
    receiveAppViewForTest(snapshot(12, { lastResult: { "provider-key": result("op-2", false) } }));
    await expect(pending).resolves.toMatchObject({ operationId: "op-2", ok: false });
    expect(host.configEnqueue).toHaveBeenCalledWith("provider-key", { provider: "openai", token: "k" });
  });

  it("tells each card only about its own operations", () => {
    const view = { revision: 1, settings: null, config: {
      running: { operationId: "a", kind: "refresh-catalogs" as const, startedAt: "" },
      queued: [{ operationId: "b", kind: "provider-key" as const, position: 1 }],
      lastResult: {
        language: result("c", false, "2026-11-18T00:00:01.000Z"),
        profile: result("d", false, "2026-11-18T00:00:02.000Z"),
        environment: result("e", false, "2026-11-18T00:00:03.000Z", "config-cancelled"),
      },
    } };
    expect(configPending(view, ["shisa-login", "refresh-catalogs"])).toBe(true);
    expect(configPending(view, ["provider-key"])).toBe(true);
    expect(configPending(view, ["environment"])).toBe(false);
    expect(configFailure(view, ["language", "profile"])?.operationId).toBe("d");
    expect(configFailure(view, ["environment"])).toBeNull();
    expect(configFailure(view, ["provider-key"])).toBeNull();
  });
});

describe("held catalog revision", () => {
  const held = { sourceId: "s", revision: "r1", digest: "d", reasons: ["new models"], changes: null };
  const report = (operationId: string, finishedAt: string) => ({ ...result(operationId, true, finishedAt), params: { catalog: { status: "quarantined", sources: [], held } } });
  const view = (lastResult: AppView["config"]["lastResult"]) => ({ revision: 1, settings: null, config: { running: null, queued: [], lastResult } });

  it("comes from the newest refresh until a later decision settles it", async () => {
    const { heldCatalog } = await import("./app-view");
    expect(heldCatalog(view({ "refresh-catalogs": report("op-1", "2026-11-18T00:00:01.000Z") }))).toMatchObject({ operationId: "op-1", held: { revision: "r1" } });
    expect(heldCatalog(view({ "shisa-login": report("op-2", "2026-11-18T00:00:02.000Z"), "refresh-catalogs": report("op-1", "2026-11-18T00:00:01.000Z") }))?.operationId).toBe("op-2");
    expect(heldCatalog(view({ "refresh-catalogs": report("op-1", "2026-11-18T00:00:01.000Z"), "catalog-accept": result("op-3", true, "2026-11-18T00:00:02.000Z") }))).toBeNull();
    expect(heldCatalog(view({ "refresh-catalogs": report("op-4", "2026-11-18T00:00:03.000Z"), "catalog-accept": result("op-3", true, "2026-11-18T00:00:02.000Z") }))?.operationId).toBe("op-4");
    const nameless = { ...report("op-5", "2026-11-18T00:00:04.000Z"), params: { catalog: { status: "quarantined", sources: [], held: { revision: "r2" } } } };
    expect(heldCatalog(view({ "refresh-catalogs": nameless }))).toBeNull();
  });
});

describe("a command whose result was replaced", () => {
  it("resolves with the newer result instead of waiting forever", async () => {
    setAppViewForTest(null);
    const host = { configEnqueue: vi.fn(async () => ({ operationId: "op-5", position: 0 })), appView: vi.fn(async () => snapshot(0)) };
    configureAppView(host as unknown as HostClient);
    receiveAppViewForTest(snapshot(20, { queued: [] }));
    const pending = runConfig("language", { uiLocale: "ja" });
    await Promise.resolve();
    receiveAppViewForTest(snapshot(21, { queued: [{ operationId: "op-5", kind: "language", position: 0 }] }));
    // Two language changes finished during a gap; only the newer one is seen.
    receiveAppViewForTest(snapshot(25, { lastResult: { language: result("op-6", true) } }));
    await expect(pending).resolves.toMatchObject({ operationId: "op-6" });
  });
});
