import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { deflateSync } from "node:zlib";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG of noise: it must be genuinely large, so the attachment pipeline has to shrink it. */
function noisyPng(size = 900): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let seed = 123456789;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = seed & 0xff;
      raw[offset + 1] = (seed >> 8) & 0xff;
      raw[offset + 2] = (seed >> 16) & 0xff;
      raw[offset + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A per-handle fixture: every `chat_start` gets its own record queue and session,
 * so the test can tell a background turn from the visible one. A prompt opens a
 * turn that stays open until `abort`.
 */
async function setup(page: Page) {
  await page.addInitScript(({ workspace }) => {
    localStorage.setItem("jouzu.ui.language", "en");
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.startCalls = [];
    w.switchCalls = [];
    w.promptCalls = [];
    w.abortCalls = [];
    w.stopCalls = [];
    w.dialogReplies = [];
    w.capacityError = null;
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    const alpha = "C:/sessions/alpha.jsonl";
    const beta = "C:/sessions/beta.jsonl";
    const sessions = [
      { path: alpha, title: "Alpha", workspace, updated: 100, pinned: false, archived: false },
      { path: beta, title: "Beta", workspace, updated: 99, pinned: false, archived: false },
    ];
    const histories: Record<string, any[]> = {
      [alpha]: [
        { role: "user", content: [{ type: "text", text: "Alpha question" }] },
        { role: "assistant", content: [{ type: "text", text: "Alpha answer" }], stopReason: "endTurn" },
      ],
      [beta]: [
        { role: "user", content: [{ type: "text", text: "Beta question" }] },
        { role: "assistant", content: [{ type: "text", text: "Beta answer" }], stopReason: "endTurn" },
      ],
    };
    interface HandleState { current: string | null; running: boolean; queue: any[] }
    const handles = new Map<string, HandleState>();
    let seq = 0;
    const response = (state: HandleState, request: any, data?: any) => state.queue.push({ type: "response", id: request.id, command: request.type, success: true, data });
    const sessionFile = (state: HandleState) => state.current ?? "C:/sessions/new.jsonl";
    const sessionId = (state: HandleState) => state.current ? String(state.current).replace(/^.*[\\/]|\.jsonl$/g, "") : "new";
    w.handleSummary = () => [...handles.entries()]
      .filter(([, state]) => state.current)
      .map(([handle, state]) => ({ handle, session: state.current, running: state.running }));
    w.handleCount = () => handles.size;
    let dialogSeq = 0;
    // A background turn can ask a question at any time; this lets the test choose
    // which session asks and when.
    w.raiseDialog = (sessionPath: string) => {
      for (const [handle, state] of handles) {
        if (state.current !== sessionPath) continue;
        const id = `dlg-${++dialogSeq}`;
        state.queue.push({ type: "extension_ui_request", id, method: "confirm", title: "Allow this?", message: "Background question" });
        return { handle, id };
      }
      return null;
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "shell_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: workspace, environment: { kind: "windows" } }] };
        if (command === "control_request") return { schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
        if (command === "component_versions") return { jouzu: "0.3.8", development: true };
        if (command === "chat_sessions") return sessions;
        if (command === "chat_session_messages") return histories[String(args.sessionPath)] ?? [];
        if (command === "textguard_reviews_read") return null;
        if (command === "chat_flow_reports") return [];
        if (command === "chat_session_timing") return { modelMs: 1, toolMs: 1, turns: 1, steps: 1, outputTokens: 1 };
        if (command === "environment_read") return [];
        if (command === "chat_scratch_dir") return "C:/Temp/jz-scratch";
        if (command === "chat_start") {
          const handle = `lock-${++seq}`;
          handles.set(handle, { current: null, running: false, queue: [] });
          w.startCalls.push(handle);
          return handle;
        }
        if (command === "chat_stop") { w.stopCalls.push(args.handle); handles.delete(String(args.handle)); return null; }
        if (command === "chat_poll_many") return (args.handles as string[]).map(handle => ({ handle, records: handles.get(handle)?.queue.splice(0) ?? [], closed: false }));
        if (command === "chat_poll") {
          const state = handles.get(String(args.handle));
          if (!state) return { records: [], closed: true, error: "Runtime disconnected." };
          return { records: state.queue.splice(0), closed: false };
        }
        if (command === "chat_send") {
          const state = handles.get(String(args.handle));
          const request = args.request;
          if (!state) return 1;
          if (request.type === "switch_session") {
            w.switchCalls.push(request.sessionPath);
            state.current = String(request.sessionPath);
            response(state, request, { cancelled: false });
          }
          else if (request.type === "new_session") { state.current = null; state.running = false; response(state, request, { cancelled: false }); }
          else if (request.type === "get_state") response(state, request, { sessionId: sessionId(state), sessionFile: sessionFile(state), isStreaming: state.running, model: { name: "Lock model" } });
          else if (request.type === "get_messages") response(state, request, { messages: state.current ? histories[state.current] ?? [] : [] });
          else if (request.type === "get_available_models") response(state, request, { models: [{ provider: "fixture", id: "deterministic", name: "Lock model" }] });
          else if (request.type === "get_available_thinking_levels") response(state, request, { levels: [] });
          else if (request.type === "get_session_stats") response(state, request, { userMessages: 2, assistantMessages: 2, toolCalls: 0 });
          else if (request.type === "prompt") {
            if (w.capacityError) {
              state.queue.push({ type: "response", id: request.id, command: request.type, success: false, error: w.capacityError });
              return;
            }
            w.promptCalls.push({ handle: args.handle, message: request.message, imageBytes: (request.images ?? []).reduce((sum: number, image: any) => sum + String(image?.data ?? "").length, 0) });
            const text = String(request.message);
            state.running = true;
            const user = { role: "user", content: [{ type: "text", text }] };
            state.queue.push({ type: "agent_start" }, { type: "message_start", message: user }, { type: "message_end", message: user }, { type: "message_start", message: { role: "assistant", content: [] } });
            response(state, request);
          }
          else if (request.type === "abort") {
            w.abortCalls.push(args.handle);
            state.running = false;
            state.queue.push({ type: "agent_end", willRetry: false }, { type: "agent_settled" });
            response(state, request);
          }
          else if (request.type === "clear_queue") response(state, request);
          else if (request.type === "extension_ui_response") {
            w.dialogReplies.push({ handle: args.handle, id: request.id, confirmed: request.confirmed ?? null });
          }
          else response(state, request);
          return;
        }
        if (command.includes("version")) return "0.3.8";
        return 1;
      },
    };
  }, { workspace: "C:/Projects/Lock" });

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
}

test("a running turn does not lock the app to one session", async ({ page }) => {
  await setup(page);

  // Open Alpha from disk, then send: that attaches its runtime and starts a turn.
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Alpha answer");
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  await page.getByLabel("Message Jouzu").fill("Alpha keeps running");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.locator("[data-session-running]")).toHaveCount(1);

  // New session while the turn is still running: no refusal, and Alpha stays alive.
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.getByText("What would you like to build?")).toBeVisible();
  await expect(page.getByText("Wait for the current turn to finish")).toHaveCount(0);
  await expect(page.locator("[data-session-running]")).toHaveCount(1);

  // The fresh runtime is usable while Alpha's turn is in flight.
  await page.getByLabel("Message Jouzu").fill("second task");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.length)).toBe(2);
  const prompts = await page.evaluate(() => (window as any).promptCalls);
  expect(prompts[0].message).toBe("Alpha keeps running");
  expect(prompts[1].message).toBe("second task");
  expect(prompts[0].handle).not.toBe(prompts[1].handle);

  const summary = await page.evaluate(() => (window as any).handleSummary());
  const alphaHandles = summary.filter((item: any) => item.session === "C:/sessions/alpha.jsonl");
  expect(alphaHandles).toHaveLength(1);
  expect(alphaHandles[0].running).toBe(true);

  // Switching back binds the live runtime: no switch_session, live transcript, Stop.
  const switchesBefore = await page.evaluate(() => (window as any).switchCalls.length);
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByRole("article", { name: "user message" }).last()).toContainText("Alpha keeps running");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).switchCalls.length)).toBe(switchesBefore);

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).abortCalls.length)).toBe(1);
  await expect(page.locator("[data-session-running]")).toHaveCount(0);
  const aborted = await page.evaluate(() => (window as any).abortCalls);
  expect(aborted[0]).toBe(prompts[0].handle);
  // Ending a turn must not stop a session runtime; only the blank entry runtime
  // that was never used may be closed.
  const stops = await page.evaluate(() => (window as any).stopCalls);
  expect(stops).not.toContain(prompts[0].handle);
  expect(stops).not.toContain(prompts[1].handle);
  // Bounded: entry + four warm + Alpha + the new session.
  expect(await page.evaluate(() => (window as any).handleCount())).toBeLessThanOrEqual(8);
});

test("two sessions in one workspace run turns side by side", async ({ page }) => {
  await setup(page);

  await page.getByRole("button", { name: /^Alpha/ }).click();
  await page.getByLabel("Message Jouzu").fill("alpha work");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  // Beta is a preview: its transcript is on screen, and Stop must not point at
  // the turn that is still running in Alpha.
  await page.getByRole("button", { name: /^Beta/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("Beta answer");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-session-running]")).toHaveCount(1);

  await page.getByLabel("Message Jouzu").fill("beta work");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.length)).toBe(2);
  await expect(page.locator("[data-session-running]")).toHaveCount(2);

  const summary = await page.evaluate(() => (window as any).handleSummary());
  expect(summary.filter((item: any) => item.session === "C:/sessions/alpha.jsonl")).toHaveLength(1);
  expect(summary.filter((item: any) => item.session === "C:/sessions/beta.jsonl")).toHaveLength(1);
  expect(summary.every((item: any) => item.running)).toBe(true);

  // Each session keeps its own turn; Stop reaches only the one on screen.
  const prompts = await page.evaluate(() => (window as any).promptCalls);
  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).abortCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).abortCalls)).toEqual([prompts[0].handle]);
  await expect(page.locator("[data-session-running]")).toHaveCount(1);

  await page.getByRole("button", { name: /^Beta/ }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).abortCalls.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).abortCalls)).toEqual([prompts[0].handle, prompts[1].handle]);
  await expect(page.locator("[data-session-running]")).toHaveCount(0);
});

test("an oversized image is shrunk before it reaches the runtime", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.waitForTimeout(600);

  await page.locator('input[aria-label="Choose images"]').setInputFiles({ name: "big.png", mimeType: "image/png", buffer: noisyPng() });
  await expect(page.getByRole("img", { name: "Preview of big.png" })).toBeVisible({ timeout: 20000 });

  await page.getByLabel("Message Jouzu").fill("describe this image");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.length)).toBe(1);

  const calls = await page.evaluate(() => (window as any).promptCalls);
  expect(calls[0].message).toBe("describe this image");
  // The runtime keeps this payload against a 4 MiB per-session budget, so one image
  // must arrive well under it.
  expect(calls[0].imageBytes).toBeGreaterThan(0);
  expect(calls[0].imageBytes).toBeLessThanOrEqual(200 * 1024);
});

test("a full flow store explains itself and offers a new session", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.waitForTimeout(600);
  await page.evaluate(() => { (window as any).capacityError = "Submission retention limit reached; admission is held."; });

  await page.getByLabel("Message Jouzu").fill("hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const alert = page.locator('[role="alert"]').first();
  await expect(alert).toContainText("used up its stored message budget");
  await expect(alert).not.toContainText("Submission retention");
  await expect(alert.getByRole("button", { name: "New session" })).toBeVisible();
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // The toast must not leak the raw runtime text either.
  await expect(page.getByText("Submission retention limit reached")).toHaveCount(0);

  await alert.getByRole("button", { name: "New session" }).click();
  await expect(page.getByText("What would you like to build?")).toBeVisible();
});

test("a dialog raised by a background session waits for that session", async ({ page }) => {
  await setup(page);

  await page.getByRole("button", { name: /^Alpha/ }).click();
  await page.getByLabel("Message Jouzu").fill("alpha work");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Beta/ }).click();
  await page.getByLabel("Message Jouzu").fill("beta work");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.length)).toBe(2);

  // Alpha asks while Beta is the session on screen: the question belongs to Alpha.
  const raised = await page.evaluate(() => (window as any).raiseDialog("C:/sessions/alpha.jsonl"));
  expect(raised).toBeTruthy();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: /^Alpha/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Allow this?");
  await page.getByRole("dialog").getByRole("button", { name: "Yes" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).dialogReplies.length)).toBe(1);

  const replies = await page.evaluate(() => (window as any).dialogReplies);
  expect(replies).toEqual([{ handle: raised.handle, id: raised.id, confirmed: true }]);
  expect(await page.evaluate(() => (window as any).abortCalls)).toHaveLength(0);
  await expect(page.locator("[data-session-running]")).toHaveCount(2);
});
