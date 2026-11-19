import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { deflateSync } from "node:zlib";

// A real PNG, produced here: the client now refuses images thinner than the model
// minimum, so a 1x1 fixture would be rejected before the composer ever shows it.
function pngOfSide(side: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((side * 4 + 1) * side);
  for (let row = 0; row < side; row += 1) raw[row * (side * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

test("the last workspace opens and prewarms chat without a workspace click", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jouzu.ui.language", "en");
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.chatCalls = [];
    w.chatRequests = [];
    // The test serves assets over a plain-HTTP origin; real webviews and localhost are secure contexts.
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    const records: any[] = [];
    const history: any[] = [];
    const models = [{ provider: "fixture", id: "deterministic", name: "Fixture model" }];
    const response = (r: any, data?: any) => records.push({ type: "response", id: r.id, command: r.type, success: true, data });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        w.chatCalls.push(command);
        if (command === "shell_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: "C:/Projects/Example", environment: { kind: "windows" } }] };
        if (command === "control_request") return { schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
        if (command === "component_versions") return { jouzu: "0.3.8", development: true };
        if (command === "chat_sessions") return [];
        if (command === "chat_flow_reports") return [{ kind: "work", text: JSON.stringify({ kind: "work", content: "Resume flow" }) }];
        if (command === "chat_session_timing") return { modelMs: 60000, toolMs: 30000, turns: 2, steps: 3, outputTokens: 500 };
        if (command === "environment_read") return [];
        if (command === "chat_start") { records.push({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "multiloop", widgetLines: ["multiloop: 1 running"] }, { type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "multiloop", statusText: "multiloop: 1 running" }); return "chat-test"; }
        if (command === "chat_poll") return { records: records.splice(0), closed: false };
        if (command === "chat_send") {
          const r = args.request;
          w.chatRequests.push(r.type);
          if (r.type === "get_state") response(r, { sessionId: "fixture", sessionFile: "C:/sessions/fixture.jsonl", isStreaming: false, model: { name: "Fixture model" } });
          else if (r.type === "get_messages") response(r, { messages: history });
          else if (r.type === "get_available_models") response(r, { models });
          else if (r.type === "get_available_thinking_levels") response(r, { levels: [] });
          else if (r.type === "get_session_stats") response(r, { userMessages: 2, assistantMessages: 3, toolCalls: 1, tokens: { input: 200, output: 100, cacheRead: 700, cacheWrite: 0, total: 1000 }, contextUsage: { percent: 42, tokens: 42000, contextWindow: 100000 } });
          else if (r.type === "set_model") response(r, models.find(model => model.provider === r.provider && model.id === r.modelId) ?? models[0]);
          else if (r.type === "prompt" || r.type === "steer") {
            w.lastPrompt = r;
            if (r.type === "prompt") {
              const user = { role: "user", content: r.message };
              const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "Live thinking preview" }, { type: "text", text: "**Hello** from Jouzu" }], provider: "fixture", model: "deterministic", usage: { input: 200, output: 100, cacheRead: 700, cacheWrite: 0, total: 1000 } };
              history.push(user, assistant);
              records.push({ type: "agent_start" }, { type: "message_start", message: user }, { type: "message_end", message: user }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Live thinking preview" } }, { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Live thinking preview" } }, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } }, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "**Hello** from Jouzu" } }, { type: "message_end", message: assistant }, { type: "agent_end", willRetry: false }, { type: "agent_settled" });
            }
            // The released runtime answers a successful prompt with no data at all.
            response(r);
          } else if (r.type === "new_session") { history.length = 0; response(r, { cancelled: false }); }
          else response(r);
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
  // No workspace click: the app opens the last workspace and starts the runtime itself.
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await expect(page.getByText("What would you like to build?")).toBeVisible();
  await expect(page.getByRole("heading", { name: "New session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open in terminal", exact: true })).toHaveCount(0);
  // Flow belongs to the open conversation, not to the new-session hero.
  await expect(page.getByRole("button", { name: "Flow", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Session usage")).toContainText("2 turns · 3 steps");
  await expect(page.getByLabel("Session usage")).toContainText("42%");
  await page.getByRole("button", { name: /2 turns · 3 steps/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Session stats");
  await expect(page.getByRole("dialog")).toContainText("Model time");
  await expect(page.getByRole("dialog")).toContainText("Output speed (TPS)");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /1k tok/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Token usage");
  await expect(page.getByRole("dialog")).toContainText("Cache read");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "42%" }).click();
  await expect(page.getByRole("dialog")).toContainText("Context used");
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as any).chatCalls.includes("chat_start"))).toBe(true);
  expect(await page.evaluate(() => (window as any).chatCalls.includes("launch_jouzu"))).toBe(false);
  await expect(page.getByRole("complementary", { name: "Workspaces" })).toBeVisible();
  const sidebarBox = await page.getByRole("complementary", { name: "Workspaces" }).boundingBox();
  const chatBox = await page.getByLabel("Message Jouzu").boundingBox();
  expect(sidebarBox!.x).toBeLessThan(chatBox!.x);
  await page.getByRole("button", { name: "Add files or run commands" }).click();
  for (const item of ["Image", "Compact", "Model", "Export conversation"]) await expect(page.getByRole("menuitem", { name: new RegExp(`^${item}`) })).toBeVisible();
  await page.getByRole("menuitem", { name: /^Compact/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).chatRequests.includes("compact"))).toBe(true);
  await page.getByRole("button", { name: "Add files or run commands" }).click();
  await page.getByRole("menuitem", { name: /^Model/ }).click();
  await expect(page.getByLabel("Search models")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Message Jouzu").fill("Explain this project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Hello from Jouzu");
  await page.getByRole("button", { name: /Thinking/ }).last().click();
  await expect(page.getByText("Live thinking preview")).toBeVisible();
  const flow = page.getByRole("button", { name: "Flow", exact: true });
  await expect(flow).toBeVisible();
  await flow.click();
  await expect(page.getByRole("dialog", { name: "Flow details" })).toContainText("multiloop");
  await expect(page.getByRole("dialog", { name: "Flow details" })).toContainText("Resume flow");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Turn actions" }).getByRole("button", { name: /Usage 1k tok/ })).toBeVisible();
  await page.getByRole("group", { name: "Turn actions" }).getByRole("button", { name: /Usage 1k tok/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Turn usage");
  await expect(page.getByRole("dialog")).toContainText("fixture / deterministic");
  await expect(page.getByRole("dialog")).toContainText("Uncached input");
  await expect(page.getByRole("dialog")).toContainText("200 tok");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open in terminal", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Model", exact: true })).toContainText("Fixture model");
  await page.getByLabel("Choose images").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: pngOfSide(32) });
  await expect(page.getByRole("img", { name: "Preview of pixel.png" })).toBeVisible();
  await page.getByLabel("Message Jouzu").fill("Inspect this image");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("img", { name: "Preview of pixel.png" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).lastPrompt.images)).toEqual([expect.objectContaining({ type: "image", mimeType: "image/png" })]);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open in terminal", exact: true })).toHaveCount(0);
});



