import type { Page } from "@playwright/test";

/** The UI base URL. Playwright must point at this repository''s dev server. */
export const UI_BASE = process.env.JOUZU_UI_BASE ?? "http://localhost:1420";

export type Workspace = { id: string; path: string; environment: { kind: string } };

/** What a control handler can do besides answering: push host events and hear a cancel. */
export type HostStub = {
  emit(event: string, data: Record<string, unknown>): void;
  onCancel(cancel: () => void): () => void;
};

/**
 * These specs run the UI against the dev server with no host behind it, so the
 * host's /v1 API is answered at the network boundary. Without this the dev
 * server answers every /v1 path with index.html and the UI reads HTML as data.
 * `control` answers POST /v1/control (the host forwards it to control.mjs);
 * the rest is an idle host: the given folders, no sessions, nothing running.
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
  const host: HostStub = {
    emit(event, data) { seq += 1; queued.push(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify({ ...data, seq })}\n\n`); },
    onCancel(cancel) { cancels.add(cancel); return () => cancels.delete(cancel); },
  };
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/v1/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/v1/control" && method === "POST") {
      try { return await route.fulfill(json(await options.control(request.postDataJSON(), host))); }
      catch (error) { return route.fulfill(json({ error: { code: "control-failed", message: String((error as Error)?.message ?? error) } }, 409)); }
    }
    if (path === "/v1/control/cancel") { for (const cancel of [...cancels]) cancel(); return route.fulfill({ status: 204, body: "" }); }
    if (path === "/v1/timing") return route.fulfill({ status: 204, body: "" });
    if (path === "/v1/events" || path === "/v1/control/events") {
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
    if (path === "/v1/environment") return route.fulfill(json({ entries: method === "PUT" ? request.postDataJSON() : [] }));
    if (path === "/v1/sessions" || path === "/v1/sessions/persisted") return route.fulfill(json({ sessions: [] }));
    if (path === "/v1/models") return route.fulfill(json({ models: [] }));
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
