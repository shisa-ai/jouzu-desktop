import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

const workspace = "C:/Projects/Matrix";
const ids = Array.from({ length: 13 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const path = (index: number) => `C:/sessions/${ids[index]}.jsonl`;

function history(index: number) {
  if (index === 0) return [];
  if (index === 1) return [{ role: "user", content: [{ type: "text", text: "short question" }] }, { role: "assistant", content: [{ type: "text", text: "short answer" }], stopReason: "endTurn" }];
  if (index === 3) return Array.from({ length: 160 }, (_, turn) => ({
    role: turn % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `long turn ${Math.floor(turn / 2)}` }],
    ...(turn % 2 === 1 ? { stopReason: "endTurn" } : {}),
  }));
  if (index === 4) return [
    { role: "user", content: [{ type: "text", text: "image question" }] },
    { role: "assistant", content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }], stopReason: "endTurn" },
  ];
  if (index === 5) return [{ role: "user", content: [{ type: "text", text: "failed question" }] }, { role: "assistant", content: [], errorMessage: "fixture failure", stopReason: "error" }];
  if (index === 6) return [{ role: "user", content: [{ type: "text", text: "tool question" }] }, { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }], stopReason: "toolUse" }];
  if (index === 7) return [
    { role: "user", content: [{ type: "text", text: "historical TextGuard question" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "SKILL.md" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "tool-2", toolName: "read", isError: true, content: [{ type: "text", text: "TextGuard withheld this result from the model: 1 error-level finding." }] },
  ];
  if (index === 11) return [
    { role: "user", content: [{ type: "text", text: "settled TextGuard question" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "tool-4", name: "read", arguments: { path: "SKILL.md" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "tool-4", toolName: "read", isError: true, content: [{ type: "text", text: "TextGuard withheld this result from the model: 1 error-level finding." }] },
  ];
  if (index === 12) return [
    { role: "user", content: [{ type: "text", text: "first question" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "endTurn" },
    { role: "user", content: [{ type: "text", text: "second question" }] },
    { role: "assistant", content: [{ type: "text", text: "second answer" }], stopReason: "endTurn" },
  ];
  return [{ role: "user", content: [{ type: "text", text: `session ${index} question` }] }, { role: "assistant", content: [{ type: "text", text: `session ${index} answer` }], stopReason: "endTurn" }];
}

async function setup(page: Page) {
  await page.addInitScript(({ ids, paths, histories }) => {
    localStorage.setItem("jouzu.ui.language", "en");
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.switchCalls = [];
    w.promptCalls = [];
    w.forkCalls = [];
    w.branchCalls = [];
    w.compactCalls = [];
    w.getMessagesCalls = [];
    w.failMessagesFor = null;
    w.exportCalls = [];
    w.modelCalls = [];
    w.thinkingCalls = [];
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    const sessions = ids.map((id: string, index: number) => ({ path: paths[index], title: `S${index}`, workspace: "C:/Projects/Matrix", updated: 100 - index, pinned: false, archived: false }));
    let current = "";
    let approvedLive = false;
    const records: any[] = [];
    const handleStates = new Map<string, { current: string; records: any[]; approvedLive: boolean }>();
    let handleSeq = 0;
    let currentOut = records;
    const response = (request: any, data?: any) => currentOut.push({ type: "response", id: request.id, command: request.type, success: true, data });
    const sessionFile = () => current ? `C:/sessions/${current}.jsonl` : "C:/sessions/new.jsonl";
    const review = { ok: true, action: "inspect", sessionId: ids[2], mode: "on", items: [{ id: "matrix-review", withheld: true, ticket: "ticket", source: "SKILL.md", digest: "a".repeat(64), severity: "error", review: { source: "SKILL.md", digest: "a".repeat(64), scanner: "fixture", status: "withheld", severity: { error: 1 }, findings: [{ kind: "yara:command_injection" }] }, snapshot: { body: "reviewed body" } }] };
    const liveReview = { ...review, sessionId: ids[7], items: [{ ...review.items[0], id: "live-review", source: "LIVE.md" }] };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "launcher_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: "C:/Projects/Matrix", environment: { kind: "windows" } }] };
        if (command === "control_request") return { schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
        if (command === "component_versions") return { jouzu: "0.3.8", development: true };
        if (command === "chat_sessions") return sessions;
        if (command === "chat_session_messages") return histories[String(args.sessionPath)] ?? [];
        if (command === "chat_session_branch") {
          const source = String(args.sessionPath);
          const index = Number(args.messageIndex);
          const branchPath = "C:/sessions/branch-1.jsonl";
          histories[branchPath] = (histories[source] ?? []).slice(0, index + 1);
          w.branchCalls.push({ source, index });
          return branchPath;
        }
        if (command === "textguard_reviews_read") return String(args.sessionId) === ids[2] ? review : null;
        if (command === "textguard_reviews_write" || command === "textguard_reviews_clear") return null;
        if (command === "chat_flow_reports") return [{ kind: "note", text: "matrix report" }];
        if (command === "chat_session_timing") return { modelMs: 1, toolMs: 1, turns: 1, steps: 1, outputTokens: 1 };
        if (command === "environment_read") return [];
        if (command === "plugin:dialog|save") return "C:/tmp/export.html";
        if (command === "chat_scratch_dir") return "C:/Temp/jz-scratch";
        if (command === "chat_poll_many") return (args.handles as string[]).map(handle => ({ handle, records: (handleStates.get(handle)?.records ?? []).splice(0), closed: false }));
        if (command === "chat_start") return "matrix-test";
        if (command === "chat_poll") return { records: records.splice(0), closed: false };
        if (command === "chat_send") {
          const request = args.request;
          if (request.type === "switch_session") { w.switchCalls.push(request.sessionPath); current = String(request.sessionPath).replace(/^.*[\\/]|\.jsonl$/g, ""); response(request, { cancelled: false }); }
          else if (request.type === "new_session") { current = ""; response(request, { cancelled: false }); }
          else if (request.type === "get_state") response(request, { sessionId: current || "new", sessionFile: sessionFile(), isStreaming: false, model: { name: "Matrix model" } });
          else if (request.type === "get_messages") {
            w.getMessagesCalls.push(sessionFile());
            if (w.failMessagesFor === sessionFile()) currentOut.push({ type: "response", id: request.id, command: "get_messages", success: false, error: "JSONL frame exceeds 33554432 bytes" });
            else response(request, { messages: histories[sessionFile()] ?? [] });
          }
          else if (request.type === "get_available_models") response(request, { models: [{ provider: "fixture", id: "deterministic", name: "Matrix model" }, { provider: "fixture", id: "alternate", name: "Alternate model" }] });
          else if (request.type === "get_available_thinking_levels") response(request, { levels: ["low", "medium"] });
          else if (request.type === "get_session_stats") response(request, { userMessages: 1, assistantMessages: 1, toolCalls: 0, tokens: { total: 1 } });
          else if (request.type === "prompt") {
            w.promptCalls.push(request.message);
            if (current === ids[12] && String(request.message).trim() === "continue") {
              records.push({ type: "extension_ui_request", id: `tg-alert-${w.promptCalls.length}`, method: "notify", message: "TextGuard withheld LIVE.md: yara:command_injection. Run /textguard to review and approve it." });
            }
            if (String(request.message).startsWith("/textguard-desktop") && String(request.message).includes("inspect")) {
              const payload = current === ids[7]
                ? (state.approvedLive ? { ...liveReview, items: [] } : liveReview)
                : { ...review, sessionId: current || "new", items: [] };
              records.push({ type: "extension_ui_request", id: `tg-${w.promptCalls.length}`, method: "notify", message: `JOUZU_TEXTGUARD ${JSON.stringify(payload)}` });
            }
            if (String(request.message).startsWith("/textguard-desktop") && String(request.message).includes('"action":"approve"') && current === ids[7]) state.approvedLive = true;
            response(request);
          }
          else if (request.type === "get_fork_messages") {
            const messages = (histories[sessionFile()] ?? [])
              .filter(item => item.role === "user")
              .map((item, index) => ({ entryId: `${sessionFile()}#${index}`, text: item.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n").trim() }));
            response(request, { messages });
          }
          else if (request.type === "fork") {
            w.forkCalls.push(request.entryId);
            const source = sessionFile();
            const history = histories[source] ?? [];
            const ordinal = Number(String(request.entryId).split("#").pop());
            let users = -1;
            let cut = history.length;
            history.forEach((item: any, index: number) => {
              if (item.role !== "user") return;
              users += 1;
              if (users === ordinal && cut === history.length) cut = index;
            });
            current = "branch-1";
            histories[sessionFile()] = history.slice(0, cut);
            response(request, { cancelled: false });
          }
          else if (request.type === "compact") { w.compactCalls.push(current); response(request, {}); }
          else if (request.type === "set_model") { w.modelCalls.push({ session: current, provider: request.provider, modelId: request.modelId }); response(request, { name: "Alternate model" }); }
          else if (request.type === "set_thinking_level") { w.thinkingCalls.push({ session: current, level: request.level }); response(request, {}); }
          else if (request.type === "export_html") { w.exportCalls.push({ session: current, path: request.outputPath }); response(request, { path: request.outputPath }); }
          else response(request);
          return;
        }
        if (command.includes("version")) return "0.3.8";
        return 1;
      },
    };
  }, { ids, paths: ids.map((_, index) => path(index)), histories: Object.fromEntries(ids.map((_, index) => [path(index), history(index)])) });
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

test("matrix: every session shape opens without attaching the runtime", async ({ page }) => {
  await setup(page);
  for (const index of [1, 0, 3, 4, 5, 6]) {
    await page.getByRole("button", { name: new RegExp(`^S${index}\\b`) }).click();
    const article = page.getByRole("article", { name: "assistant message" });
    if (index === 0) await expect(page.getByText("What would you like to work on?")).toBeVisible();
    if (index === 1) await expect(article).toContainText("short answer");
    if (index === 3) await expect(article.last()).toBeVisible();
    if (index === 4) await expect(page.getByRole("img", { name: "Conversation attachment" })).toBeVisible();
    if (index === 5) await expect(page.getByRole("alert")).toContainText("fixture failure");
    if (index === 6) await expect(page.getByRole("button", { name: /read/i })).toBeVisible();
    expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  }
});

test("matrix: rapid and repeated switching keeps one final transcript", async ({ page }) => {
  await setup(page);
  const marks: number[] = [];
  for (const index of [1, 7, 8, 9, 10, 11, 1, 8, 1, 8]) {
    await page.getByRole("button", { name: new RegExp(`^S${index}\\b`) }).click();
    await page.waitForTimeout(40);
    marks.push(await page.getByRole("article").count());
  }
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("session 8 answer");
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  expect(marks.every(count => count > 0)).toBe(true);
});

test("matrix: long transcripts open at the newest turn and stay bounded", async ({ page }) => {
  await setup(page);
  const mark = await page.evaluate(() => { const value = performance.now(); (window as any).__matrixClick = value; return value; });
  await page.getByRole("button", { name: /^S3\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" }).last()).toContainText("long turn 79");
  const result = await page.evaluate(() => {
    const el = document.querySelector('section[aria-label="Conversation"] .overflow-y-auto');
    return { elapsed: performance.now() - (window as any).__matrixClick, gap: el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1, articles: document.querySelectorAll("article").length };
  });
  expect(result.gap).toBeLessThan(2);
  expect(result.articles).toBeLessThanOrEqual(30);
  expect(result.elapsed).toBeLessThan(500);
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
});

test("matrix: refresh during a session view does not create a second load", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S8\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("session 8 answer");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await page.getByRole("button", { name: /^S8\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("session 8 answer");
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
});

test("matrix: TextGuard history is hidden while the session is only previewed", async ({ page }) => {
  await setup(page);
  for (const title of ["S2", "S7"]) {
    await page.getByRole("button", { name: new RegExp(`^${title}\\b`) }).click();
    await expect(page.getByRole("region", { name: "TextGuard" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  }
});

test("matrix: TextGuard mode is a composer dropdown", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S2\b/ }).click();
  const composer = page.getByLabel("Message Jouzu");
  await composer.fill("continue");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).switchCalls.length)).toBe(1);

  await page.getByRole("button", { name: /^TextGuard/ }).click();
  const menu = page.getByRole("menu", { name: "TextGuard mode" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "On" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Strict" }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.some((call: string) => call.includes('/textguard strict')))).toBe(true);
});
test("matrix: a live TextGuard alert turns the composer icon red", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S12\b/ }).click();
  const composer = page.getByLabel("Message Jouzu");
  await composer.fill("continue");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).switchCalls.length)).toBe(1);
  await expect(page.getByRole("button", { name: /^TextGuard/ })).toContainText("1 blocked");
});
test("matrix: fork from a preview attaches and opens the branch", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  await page.getByRole("button", { name: "Branch into a new conversation" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).branchCalls.length)).toBe(1);
  await expect(page.getByText("Branched into a new conversation.")).toBeVisible();
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).branchCalls))
    .toEqual([{ source: "C:/sessions/00000000-0000-4000-8000-000000000002.jsonl", index: 1 }]);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual([
      "C:/sessions/00000000-0000-4000-8000-000000000002.jsonl",
      "C:/sessions/branch-1.jsonl",
    ]);
});

test("matrix: fork on the attached session switches to the branch", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  const composer = page.getByLabel("Message Jouzu");
  await composer.fill("continue");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).switchCalls.length)).toBe(1);
  await page.getByRole("button", { name: "Branch into a new conversation" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).branchCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual([
      "C:/sessions/00000000-0000-4000-8000-000000000002.jsonl",
      "C:/sessions/branch-1.jsonl",
    ]);
});

test("matrix: compact from a preview never fetches the transcript", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any;
    w.failMessagesFor = "C:/sessions/00000000-0000-4000-8000-000000000002.jsonl";
    w.getMessagesCalls.length = 0;
  });
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await page.getByRole("button", { name: "Add files or run commands" }).click();
  await page.getByRole("menuitem", { name: /Compact/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).compactCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).getMessagesCalls)).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("matrix: compact from a preview attaches that session first", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  await page.getByRole("button", { name: "Add files or run commands" }).click();
  await page.getByRole("menuitem", { name: /Compact/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).compactCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual(["C:/sessions/00000000-0000-4000-8000-000000000002.jsonl"]);
  expect(await page.evaluate(() => (window as any).compactCalls))
    .toEqual(["00000000-0000-4000-8000-000000000002"]);
});

test("matrix: export from a preview attaches before exporting", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await page.getByRole("button", { name: "Add files or run commands" }).click();
  await page.getByRole("menuitem", { name: /Export conversation/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).exportCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual(["C:/sessions/00000000-0000-4000-8000-000000000002.jsonl"]);
  expect(await page.evaluate(() => (window as any).exportCalls))
    .toEqual([{ session: "00000000-0000-4000-8000-000000000002", path: "C:/tmp/export.html" }]);
});


test("matrix: changing the model from a preview attaches that session first", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  expect(await page.evaluate(() => (window as any).switchCalls)).toHaveLength(0);
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /Alternate model/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).modelCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual(["C:/sessions/00000000-0000-4000-8000-000000000002.jsonl"]);
  expect(await page.evaluate(() => (window as any).modelCalls))
    .toEqual([{ session: "00000000-0000-4000-8000-000000000002", provider: "fixture", modelId: "alternate" }]);
});

test("matrix: changing the thinking level from a preview attaches that session first", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page.getByRole("button", { name: "medium", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).thinkingCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual(["C:/sessions/00000000-0000-4000-8000-000000000002.jsonl"]);
  expect(await page.evaluate(() => (window as any).thinkingCalls))
    .toEqual([{ session: "00000000-0000-4000-8000-000000000002", level: "medium" }]);
});

test("matrix: a flow command from a preview attaches that session first", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await page.getByRole("button", { name: "Flow", exact: true }).click();
  await page.getByRole("button", { name: "Status", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).promptCalls.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).switchCalls))
    .toEqual(["C:/sessions/00000000-0000-4000-8000-000000000002.jsonl"]);
  expect(await page.evaluate(() => (window as any).promptCalls)).toEqual(["/flow"]);
});

test("matrix: fork at the selected turn keeps that turn", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S12\b/ }).click();
  await expect(page.getByText("second answer")).toBeVisible();
  await page.getByRole("button", { name: "Branch into a new conversation" }).last().click();
  await expect.poll(() => page.evaluate(() => (window as any).branchCalls.length)).toBe(1);
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await expect(page.getByText("first answer")).toBeVisible();
  await expect(page.getByText("second answer")).toBeVisible();
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).branchCalls))
    .toEqual([{ source: "C:/sessions/00000000-0000-4000-8000-000000000013.jsonl", index: 3 }]);
});

test("matrix: fork on a single-turn session keeps its turn", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: /^S1\b/ }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await page.getByRole("button", { name: "Branch into a new conversation" }).last().click();
  await expect.poll(() => page.evaluate(() => (window as any).branchCalls.length)).toBe(1);
  await expect(page.getByLabel("Message Jouzu")).toBeVisible();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText("short answer");
  await expect(page.getByLabel("Message Jouzu")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).branchCalls))
    .toEqual([{ source: "C:/sessions/00000000-0000-4000-8000-000000000002.jsonl", index: 1 }]);
});





