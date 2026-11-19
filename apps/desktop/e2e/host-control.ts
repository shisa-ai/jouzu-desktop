import type { Page } from "@playwright/test";

/** The UI base URL. Playwright must point at this repository''s dev server. */
export const UI_BASE = process.env.JOUZU_UI_BASE ?? "http://localhost:1420";

export type Workspace = { id: string; path: string; environment: { kind: string } };

/** What a control handler can do besides answering: show a sign-in's device code, push host events and hear a cancel. */
export type HostStub = {
  device(data: Record<string, unknown>): void;
  emit(event: string, data: Record<string, unknown>): void;
  onCancel(cancel: () => void): () => void;
};

/**
 * These specs run the UI against the dev server with no host behind it, so the
 * host's /v1 API is answered at the network boundary. Without this the dev
 * server answers every /v1 path with index.html and the UI reads HTML as data.
 * `control` plays the configuration service: it gets `{ action, ...fields }` for
 * each queued operation and answers the settings (or throws to fail it). The
 * stub plays the host's queue around it: `POST /v1/config/{kind}` is accepted at
 * once, operations run one at a time, and `app.updated` carries the snapshot.
 * A `modelReady` field in the answer is the fixture's runtime: it answers one
 * model in `/v1/models` unless it is `false`; it is not sent to the window.
 * The rest is an idle host: the given folders, no sessions, nothing running.
 * A path not listed here is a 404, as from a host that does not serve it.
 */
export async function stubHost(
  page: Page,
  options: { control: (body: any, host: HostStub) => unknown; workspaces?: Workspace[] },
) {
  const workspaces = [...(options.workspaces ?? [])];
  // Events wait here until the window's stream next connects. The stub answers
  // each stream with what is queued and ends it; the window reconnects, as it
  // does when a real host closes the stream.
  const queued: string[] = [];
  let seq = 0;
  const cancels = new Set<() => void>();
  const send = (event: string, data: Record<string, unknown>) => { seq += 1; queued.push(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify({ ...data, seq })}\n\n`); };
  let modelReady = true;
  const view: { revision: number; config: { running: any; queued: any[]; lastResult: Record<string, unknown> }; settings: any } =
    { revision: 0, config: { running: null, queued: [], lastResult: {} }, settings: null };
  const publish = () => { view.revision += 1; send("app.updated", JSON.parse(JSON.stringify(view))); };
  const host: HostStub = {
    // A device code belongs to the running sign-in, as the host reports it.
    device(data) { if (view.config.running) { view.config.running.device = data; publish(); } },
    emit(event, data) { send(event, data); },
    onCancel(cancel) { cancels.add(cancel); return () => cancels.delete(cancel); },
  };
  let chain: Promise<unknown> = Promise.resolve();
  let next = 0;
  const enqueue = (kind: string, body: Record<string, unknown>) => {
    const operationId = `op-${++next}`;
    const position = view.config.queued.length + (view.config.running ? 1 : 0);
    view.config.queued.push({ operationId, kind, position });
    publish();
    chain = chain.then(async () => {
      view.config.queued = view.config.queued.filter(item => item.operationId !== operationId);
      view.config.running = { operationId, kind, startedAt: new Date().toISOString() };
      publish();
      let result: Record<string, unknown>;
      try {
        const answer: any = await options.control({ action: kind, ...body }, host);
        const { modelReady: ready, catalog, ...settings } = answer ?? {};
        if (typeof ready === "boolean") modelReady = ready;
        view.settings = settings;
        // A catalog outcome belongs to the operation that reported it.
        result = { operationId, ok: true, code: null, params: catalog ? { catalog } : {}, text: null };
      } catch (error) {
        const text = String((error as Error)?.message ?? error);
        result = { operationId, ok: false, code: text === "cancelled" ? "config-cancelled" : "config-failed", params: {}, text };
      }
      view.config.running = null;
      // The provider the operation was for, as the host records it with the result.
      const provider = typeof body.provider === "string" ? body.provider : null;
      view.config.lastResult[kind] = { ...result, provider, finishedAt: new Date().toISOString() };
      publish();
    });
    return { operationId, position };
  };
  // The host reads the settings once when it starts.
  enqueue("status", {});
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/v1/app") { await chain; return route.fulfill(json(view)); }
    const config = /^\/v1\/config\/([a-z-]+)$/.exec(path);
    if (config && method === "POST") return route.fulfill(json(enqueue(config[1], request.postDataJSON() ?? {}), 202));
    if (/^\/v1\/config\/operations\/[^/]+\/cancel$/.test(path)) { for (const cancel of [...cancels]) cancel(); return route.fulfill({ status: 204, body: "" }); }
    if (path === "/v1/timing") return route.fulfill({ status: 204, body: "" });
    if (path === "/v1/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: queued.splice(0).join("") });
    }
    if (path === "/v1/capabilities") return route.fulfill(json({ features: ["chat", "sse", "replay", "prompts", "history-paging"], scopes: ["loopback"] }));
    if (path === "/v1/workspaces" && method === "GET") return route.fulfill(json({ workspaces }));
    if (path === "/v1/workspaces" && method === "POST") {
      for (const folder of (request.postDataJSON()?.paths ?? []) as string[]) {
        if (!workspaces.some(item => item.path === folder)) workspaces.push({ id: `windows:${folder}`, path: folder, environment: { kind: "windows" } });
      }
      return route.fulfill(json({ workspaces }));
    }
    if (path === "/v1/environment") return route.fulfill(json({ entries: [] }));
    if (path === "/v1/sessions" || path === "/v1/sessions/persisted") return route.fulfill(json({ sessions: [] }));
    if (path === "/v1/models") { await chain; return route.fulfill(json({ models: modelReady ? [{ provider: "fixture", id: "model", name: "Fixture model" }] : [] })); }
    if (path === "/v1/runtime/warm") return route.fulfill(json({ state: "off" }));
    if (path === "/v1/artifacts/counts") return route.fulfill(json({ counts: {} }));
    return route.fulfill(json({ error: { code: "not-found", message: `No stub for ${method} ${path}` } }, 404));
  });
}

/** Only the control endpoints, for a spec whose other host calls do not matter. */
export async function stubHostControl(page: Page, handler: (body: any, host: HostStub) => unknown, workspaces?: Workspace[]) {
  await stubHost(page, { control: handler, workspaces });
}

/** The empty status every spec starts from, matching the control-state parser. */
export const emptyControlState = {
  schemaVersion: 1,
  profile: "core",
  account: { signedIn: false },
  credentials: [],
  customProviders: [],
  providers: [],
};
