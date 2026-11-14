import { describe, expect, test, vi } from "vitest";
import { DesktopApi, RemoteApi, WebApi } from "./adapters";
import type { DesktopBridge } from "./desktop-bridge";
import { HostClient } from "./host-client";
import {
  ApiError,
  CapabilityUnavailable,
  JouzuApi,
  type Artifact,
  type ArtifactBody,
  type ArtifactApi,
  type EnvironmentEntry,
  type FileApi,
  type FileEntry,
  type NativeApi,
  type SessionHandle,
  type SessionSummary,
  type SettingsApi,
  type Workspace,
  type WorkspaceApi,
} from "./jouzu-api";

const session: SessionSummary = {
  sessionId: "h1",
  sessionPath: "C:/sessions/h1.jsonl",
  workspacePath: "C:/work",
  title: "one",
  status: "idle",
  running: false,
  pinned: false,
  archived: false,
};

const handle: SessionHandle = {
  sessionId: "h1",
  workspacePath: "C:/work",
  sessionPath: "C:/sessions/h1.jsonl",
  status: "idle",
  cursor: 0,
};

function client() {
  const calls: string[] = [];
  const value = {
    clientId: "contract",
    capabilities: vi.fn(async () => ({ host: true, native: false, features: [], scopes: ["loopback"] })),
    status: vi.fn(async () => ({ hostVersion: "0.1.0", runtimeHome: "C:/data", node: true, app: true, bash: false, git: false, terminal: false })),
    sessions: vi.fn(async () => [session]),
    attach: vi.fn(async () => handle),
    history: vi.fn(async () => ({ messages: [], nextBefore: null })),
    messages: vi.fn(async () => []),
    send: vi.fn(async () => ({ messageId: "m-1", receipt: "queued" })),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => session),
    branch: vi.fn(async () => "C:/sessions/branch.jsonl"),
    recover: vi.fn(async () => null),
    timing: vi.fn(async () => ({ modelMs: 1, toolMs: 2, turns: 1, steps: 1, outputTokens: 3 })),
    flowReports: vi.fn(async () => [{ kind: "work", text: "{}" }]),
    approve: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    workspaces: vi.fn(async () => [{ id: "C:/work", path: "C:/work", environment: { kind: "windows" } }]),
    addWorkspaces: vi.fn(async () => [{ id: "C:/work", path: "C:/work", environment: { kind: "windows" } }]),
    forgetWorkspace: vi.fn(async () => []),
    models: vi.fn(async () => ({ models: [{ id: "m", name: "Model", provider: "p" }] })),
    selectModel: vi.fn(async () => undefined),
    setThinking: vi.fn(async () => undefined),
    tools: vi.fn(async () => ({ path: "C:/data/agent/tools.json", exists: false, settings: {} })),
    saveTools: vi.fn(async () => ({})),
    toolProviders: vi.fn(async () => ({ providers: [] })),
    toolModels: vi.fn(async () => ({ models: [] })),
    mcp: vi.fn(async () => ({ path: "C:/data/agent/mcp.json", exists: false, servers: [] })),
    stats: vi.fn(async () => { calls.push("stats"); return null; }),
    compact: vi.fn(async () => { calls.push("compact"); return {}; }),
    exportHtml: vi.fn(async () => { calls.push("export"); return {}; }),
    reload: vi.fn(async () => { calls.push("reload"); return {}; }),
    artifacts: vi.fn(async () => [{ id: "a1", kind: "images", mimeType: "image/png" }]),
    artifactCounts: vi.fn(async () => ({ h1: 1 })),
    artifact: vi.fn(async () => ({ record: { id: "a1", kind: "images", mimeType: "image/png" }, mimeType: "image/png", data: "AA==" })),
    deleteArtifact: vi.fn(async () => undefined),
    files: vi.fn(async () => [{ name: "a.txt", path: "C:/work/a.txt", isDir: false, size: 1 }]),
    environment: vi.fn(async () => [{ name: "A", value: "1", enabled: true }]),
    saveEnvironment: vi.fn(async (entries: EnvironmentEntry[]) => entries),
    subscribe: vi.fn(() => () => undefined),
  };
  return { value: value as unknown as HostClient, raw: value, calls };
}

function bridge() {
  const artifacts: ArtifactApi = {
    list: vi.fn(async () => [] as Artifact[]),
    read: vi.fn(async () => ({ record: { id: "a1", kind: "images", mimeType: "image/png" }, mimeType: "image/png", data: "AA==" } as ArtifactBody)),
    delete: vi.fn(async () => undefined),
    counts: vi.fn(async () => ({})),
  };
  const nativeFile: FileApi = {
    list: vi.fn(async () => [] as FileEntry[]),
    reveal: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ files: [], truncated: false })),
    readFile: vi.fn(async () => ({ name: 'a.png', mimeType: 'image/png', data: 'AA==' })),
  };
  const settings: SettingsApi = {
    environment: { read: vi.fn(async () => [] as EnvironmentEntry[]), save: vi.fn(async () => undefined) },
    control: vi.fn(async () => ({})),
  };
  const workspaces: WorkspaceApi = {
    list: vi.fn(async () => [] as Workspace[]),
    add: vi.fn(async () => [] as Workspace[]),
    forget: vi.fn(async () => [] as Workspace[]),
  };
  const native: NativeApi = {
    confirm: vi.fn(async () => true),
    pickFolder: vi.fn(async () => "C:/picked"),
    saveFile: vi.fn(async () => "C:/saved.html"),
    onFileDrop: vi.fn(() => () => {}),
    reveal: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    terminal: vi.fn(async () => undefined),
    installTerminal: vi.fn(async () => undefined),
    updater: { check: vi.fn(async () => ({})), install: vi.fn(async () => undefined) },
  };
  return { artifacts, files: nativeFile, settings, native, workspaces };
}

function platforms() {
  return [
    { name: "Desktop", api: new DesktopApi(client().value, bridge()), native: true },
    { name: "Web", api: new WebApi(client().value), native: false },
    { name: "Remote", api: new RemoteApi(client().value), native: false },
  ] as const;
}

describe("A-API contract suite", () => {
  test("one parent and three direct siblings", () => {
    for (const Platform of [DesktopApi, WebApi, RemoteApi]) {
      expect(Object.getPrototypeOf(Platform.prototype)).toBe(JouzuApi.prototype);
    }
  });

  test.each(platforms())("$name: host groups obey the same contract", async ({ api, native }) => {
    expect(api.capabilities.host).toBe(true);
    expect(api.capabilities.native).toBe(native);
    await expect(api.sessions.list()).resolves.toEqual([session]);
    await expect(api.sessions.attach("C:/work", "C:/sessions/h1.jsonl")).resolves.toEqual(handle);
    await expect(api.sessions.history("h1")).resolves.toEqual({ messages: [], nextBefore: null });
    await expect(api.sessions.send("h1", { clientMessageId: "c-1", text: "hi" })).resolves.toEqual({ messageId: "m-1", receipt: "queued" });
    await expect(api.sessions.branch("C:/sessions/h1.jsonl", 2)).resolves.toBe("C:/sessions/branch.jsonl");
    await expect(api.sessions.recover("C:/sessions/h1.jsonl")).resolves.toBeNull();
    await expect(api.sessions.timing("C:/sessions/h1.jsonl")).resolves.toEqual({ modelMs: 1, toolMs: 2, turns: 1, steps: 1, outputTokens: 3 });
    await expect(api.sessions.flowReports("C:/sessions/h1.jsonl")).resolves.toHaveLength(1);
    await expect(api.prompts.approve("a1", "Approve")).resolves.toBeUndefined();
    await expect(api.prompts.answer("q1", { q: "a" })).resolves.toBeUndefined();
    await expect(api.workspaces.list()).resolves.toBeDefined();
    await expect(api.artifacts.list({ kind: "images" })).resolves.toBeDefined();
    await expect(api.artifacts.counts()).resolves.toBeDefined();
    await expect(api.files.list("C:/work")).resolves.toBeDefined();
    await expect(api.settings.environment.read()).resolves.toBeDefined();
    await expect(api.commands.compact("h1")).resolves.toBeUndefined();
    await expect(api.commands.exportHtml("h1", "C:/out.html")).resolves.toBeUndefined();
    await expect(api.commands.reload("h1")).resolves.toBeUndefined();
    const unsubscribe = api.subscribe("h1", "c", ["view"], 0, () => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
    await expect(api.models.list("h1")).resolves.toEqual([{ id: "m", name: "Model", provider: "p" }]);
    await expect(api.commands.stats("h1")).resolves.toBeDefined();
  });

  test.each(platforms())("$name: native differs only by capability", async ({ api, native }) => {
    if (native) {
      await expect(api.native.pickFolder()).resolves.toBe("C:/picked");
      await expect(api.native.confirm({ message: "ok" })).resolves.toBe(true);
    } else {
      await expect(api.native.pickFolder()).rejects.toBeInstanceOf(CapabilityUnavailable);
      await expect(api.native.openExternal("https://example.com")).rejects.toMatchObject<Partial<ApiError>>({ code: "capability-unavailable" });
    }
  });

  test("createJouzuApi selects exactly one implementation", async () => {
    const { createJouzuApi } = await import("./adapters");
    const api = createJouzuApi(client().value);
    expect(api).toBeInstanceOf(JouzuApi);
    expect([DesktopApi, WebApi, RemoteApi].some(Platform => api instanceof Platform)).toBe(true);
  });
});


