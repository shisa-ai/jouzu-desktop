import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

test("Assistant opens a separate session shell without sending or replacing the chat", async ({ page }) => {
  const errors: string[] = [];
  const mutations: string[] = [];
  const assistantMessages: unknown[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "en"));
  const dist = resolve("dist");
  await page.route("http://jouzu-ui.test/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/v1/")) {
      const method = route.request().method();
      if (method !== "GET") mutations.push(`${method} ${pathname}`);
      let body: unknown;
      if (pathname === "/v1/capabilities") body = { host: true, native: false, features: [], scopes: [] };
      else if (pathname === "/v1/status") body = { hostVersion: "test", runtimeHome: "C:/Runtime", node: true, app: true, bash: true, git: true, terminal: false };
      else if (pathname === "/v1/workspaces") body = { workspaces: [{ id: "work", path: "C:/Projects/Example", environment: { kind: "windows" } }] };
      else if (pathname === "/v1/assistant") body = { messages: [], projects: [], workspaces: [], sessions: [] };
      else if (pathname === "/v1/assistant/messages" && method === "POST") {
        const request = route.request().postDataJSON();
        expect(Object.keys(request)).toEqual(["text"]);
        assistantMessages.push(request);
        body = { messages: [{ role: "user", text: request.text }, { role: "assistant", text: "Ready to organize your projects." }], projects: [], workspaces: [], sessions: [] };
      }
      else if (pathname.endsWith("/messages")) body = { messages: [], nextBefore: null };
      else if (pathname === "/v1/sessions" && method === "POST") body = { sessionId: "fixture", workspacePath: "C:/Projects/Example", sessionPath: null, status: "idle", cursor: 0 };
      else if (pathname === "/v1/sessions" || pathname === "/v1/sessions/persisted") body = { sessions: [] };
      else if (pathname === "/v1/models") body = { models: [{ provider: "fixture", id: "deterministic", name: "Fixture model" }] };
      else if (pathname === "/v1/runtime/warm") body = { state: "ready" };
      else if (pathname === "/v1/control") body = { schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [], models: [] };
      else if (pathname === "/v1/artifacts/counts") body = { counts: {} };
      else if (pathname === "/v1/artifacts") body = { artifacts: [] };
      else if (pathname.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
      else if (pathname.endsWith("/history")) body = { messages: [], hasMore: false };
      else if (pathname.endsWith("/stats")) body = { stats: {} };
      else if (pathname === "/v1/timing" || pathname.endsWith("/view")) body = {};
      else return route.fulfill({ status: 404, json: { error: { code: "invalid-request", message: `Unmocked endpoint: ${pathname}` } } });
      return route.fulfill({ json: body });
    }
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    const contentType = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType }); }
    catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("http://jouzu-ui.test/");
  const composer = page.getByLabel("Message Jouzu");
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  const assistant = page.getByRole("button", { name: "Assistant", exact: true });
  const newSession = page.getByRole("button", { name: "New session", exact: true });
  const artifacts = page.getByRole("button", { name: "Artifacts", exact: true });
  const bounds = await Promise.all([newSession.boundingBox(), assistant.boundingBox(), artifacts.boundingBox()]);
  expect(bounds[1]!.y).toBeGreaterThan(bounds[0]!.y);
  expect(bounds[1]!.y).toBeLessThan(bounds[2]!.y);
  const sessionMutations = () => mutations.filter(item => item === "POST /v1/sessions");
  const before = [...sessionMutations()];
  await assistant.click();
  await expect(assistant).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Assistant session" })).toBeVisible();
  await expect(newSession).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { name: "Assistant", exact: true })).toBeVisible();
  const assistantComposer = page.getByLabel("Message Assistant");
  await expect(assistantComposer).toBeVisible();
  await expect(page.getByRole("button", { name: "Model", exact: true })).not.toBeVisible();
  await assistantComposer.fill("Organize my projects");
  await expect(page.getByRole("button", { name: "Send to Assistant", exact: true })).toBeEnabled();
  await expect(composer).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).not.toBeVisible();
  await assistant.click();
  expect(sessionMutations()).toEqual(before);
  await artifacts.click();
  await expect(page.getByRole("region", { name: "Assistant session" })).toHaveCount(0);
  await artifacts.click();
  await expect(composer).toHaveValue("Keep this draft");
  await assistant.click();
  await expect(assistantComposer).toHaveValue("Organize my projects");
  await page.getByRole("button", { name: "Send to Assistant", exact: true }).click();
  await expect(assistantComposer).toHaveValue("");
  expect(assistantMessages).toHaveLength(1);
  await expect(page.getByText("Ready to organize your projects.")).toBeVisible();
  expect(mutations.filter(item => item.endsWith("/model"))).toEqual([]);
  await newSession.click();
  await expect(newSession).toHaveAttribute("aria-pressed", "true");
  await expect(assistant).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Assistant session" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What would you like to build?" })).toBeVisible();
  expect(errors).toEqual([]);
});
