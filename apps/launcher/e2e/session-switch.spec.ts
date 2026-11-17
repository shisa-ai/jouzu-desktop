import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

test("a session opens once and switching replaces it once", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jouzu.ui.language", "en");
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.switchCalls = [];
    w.promptCalls = [];
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    const workspace = "C:/Projects/Example";
    const now = Math.floor(Date.now() / 1000);
    const sessions = [
      { path: "C:/sessions/alpha.jsonl", title: "Alpha", workspace, updated: now, pinned: false, archived: false },
      { path: "C:/sessions/beta.jsonl", title: "Beta", workspace, updated: now - 1, pinned: false, archived: false },
    ];
    const histories: Record<string, any[]> = {
      "C:/sessions/alpha.jsonl": [
        { role: "user", content: [{ type: "text", text: "Alpha question" }] },
        { role: "assistant", content: [{ type: "text", text: "Alpha answer" }], stopReason: "endTurn" },
      ],
      "C:/sessions/beta.jsonl": [
        { role: "user", content: [{ type: "text", text: "Beta question" }] },
        { role: "assistant", content: [{ type: "text", text: "Beta answer" }], stopReason: "endTurn" },
      ],
    };
    let current = "";
    const records: any[] = [];
    const response = (request: any, data?: any) => records.push({ type: "response", id: request.id, command: request.type, success: true, data });
    const sessionFile = () => current ? `C:/sessions/${current}.jsonl` : "C:/sessions/new.jsonl";
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "launcher_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: workspace, environment: { kind: "windows" } }] };
        if (command === "control_request") return { schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
        if (command === "component_versions") return { jouzu: "0.3.8", development: true };
        if (command === "chat_sessions") return sessions;
        if (command === "chat_session_messages") return histories[String(args.sessionPath)] ?? [];
        if (command === "textguard_reviews_read") return null;
        if (command === "chat_flow_reports") return [];
        if (command === "chat_session_timing") return { modelMs: 1, toolMs: 1, turns: 1, steps: 1, outputTokens: 1 };
        if (command === "environment_read") return [];
        if (command === "chat_start") return "switch-test";
        if (command === "chat_poll") return { records: records.splice(0), closed: false };
        if (command === "chat_send") {
          const request = args.request;
          if (request.type === "switch_session") { w.switchCalls.push(request.sessionPath); current = String(request.sessionPath).replace(/^.*[\\/]|\.jsonl$/g, ""); response(request, { cancelled: false }); }
          else if (request.type === "new_session") { current = ""; response(request, { cancelled: false }); }
          else if (request.type === "get_state") response(request, { sessionId: current || "new", sessionFile: sessionFile(), isStreaming: false, model: { name: "Fixture model" } });
          else if (request.type === "get_messages") response(request, { messages: current ? histories[sessionFile()] ?? [] : [] });
          else if (request.type === "get_available_models") response(request, { models: [{ provider: "fixture", id: "deterministic", name: "Fixture model" }] });
          else if (request.type === "get_available_thinking_levels") response(request, { levels: [] });
          else if (request.type === "get_session_stats") response(request, { userMessages: 1, assistantMessages: 1, toolCalls: 0, tokens: { total: 1 } });
          else if (request.type === "prompt") { w.promptCalls.push(request.message); response(request); }
          else response(request);
          return;
        }
        if (command.includes("version")) return "0.3.8";
        return 1;
      },
    };
  });
  const dist = resolve("dist");
  await page.route("http://jouzu-ui.test/**", async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    const contentType = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("http://jouzu-ui.test/");
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Alpha answer");
  await expect(page.getByRole("article", { name: "assistant message" })).toHaveCount(1);
  await page.getByRole("button", { name: /^Beta/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Beta answer");
  await expect(page.getByRole("article", { name: "assistant message" })).toHaveCount(1);
  // Opening a saved session reads the local transcript; it must not attach the runtime.
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  await page.getByLabel("Message Jouzu").fill("Continue Beta");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).switchCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls)).toEqual(["C:/sessions/beta.jsonl"]);
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).promptCalls)).toEqual(["Continue Beta"]);
  // A successful send clears only the draft it sent.
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("");

  // A draft belongs to one session: it survives a switch and a reload.
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await page.getByLabel("Message Jouzu").fill("unsent alpha draft");
  await page.getByRole("button", { name: /^Beta/ }).click();
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("");
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("unsent alpha draft");

  // The write is debounced; let it reach localStorage before the reload.
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("unsent alpha draft");
});
