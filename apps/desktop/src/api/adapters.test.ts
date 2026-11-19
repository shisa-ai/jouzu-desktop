import { describe, expect, test } from "vitest";
import { DesktopApi, RemoteApi, WebApi } from "./adapters";
import { HostClient } from "./host-client";
import { CapabilityUnavailable, JouzuApi } from "./jouzu-api";

function client(): HostClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ sessions: [], workspaces: [], artifacts: [], counts: {}, entries: [], messages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return new HostClient({ baseUrl: "http://host", fetchImpl });
}

describe("platform adapters", () => {
  test("Desktop/Web/Remote are direct siblings of JouzuApi", () => {
    for (const Platform of [DesktopApi, WebApi, RemoteApi]) {
      expect(Object.getPrototypeOf(Platform.prototype)).toBe(JouzuApi.prototype);
    }
  });

  test("all platforms expose host capabilities and deny native", async () => {
    for (const api of [new DesktopApi(client()), new WebApi(client()), new RemoteApi(client())]) {
      expect(api).toBeInstanceOf(JouzuApi);
      expect(api.capabilities.host).toBe(true);
      expect(api.capabilities.native).toBe(false);
      await expect(api.native.pickFolder()).rejects.toBeInstanceOf(CapabilityUnavailable);
    }
  });

  test("host groups are wired through the abstract parent", async () => {
    const api = new WebApi(client());
    await expect(api.sessions.list()).resolves.toEqual([]);
    await expect(api.workspaces.list()).resolves.toEqual([]);
  });
});
