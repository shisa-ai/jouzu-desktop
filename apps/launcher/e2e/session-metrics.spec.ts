import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const ids = Array.from({ length: 8 }, (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const paths = ids.map(id => `C:/sessions/${id}.jsonl`);

function history(index: number) {
  if (index === 0) return [];
  if (index === 1) return [{ role: "user", content: [{ type: "text", text: "short question" }] }, { role: "assistant", content: [{ type: "text", text: "short answer" }], stopReason: "endTurn" }];
  if (index === 2) return [{ role: "user", content: [{ type: "text", text: "textguard question" }] }, { role: "assistant", content: [{ type: "text", text: "textguard answer" }], stopReason: "endTurn" }];
  if (index === 3) return Array.from({ length: 160 }, (_, turn) => ({
    role: turn % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `long turn ${Math.floor(turn / 2)}` }],
    ...(turn % 2 === 1 ? { stopReason: "endTurn" } : {}),
  }));
  return [{ role: "user", content: [{ type: "text", text: `session ${index} question` }] }, { role: "assistant", content: [{ type: "text", text: `session ${index} answer` }], stopReason: "endTurn" }];
}

async function setup(page: Page) {
  await page.addInitScript(({ ids, paths, histories }) => {
    localStorage.setItem("jouzu.ui.language", "en");
    const w = window as any;
    w.isTauri = true;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    w.switchCalls = [];
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
    const sessions = ids.map((id: string, index: number) => ({ path: paths[index], title: `S${index}`, workspace: "C:/Projects/Metrics", updated: 100 - index, pinned: false, archived: false }));
    let current = "";
    const records: any[] = [];
    const response = (request: any, data?: any) => records.push({ type: "response", id: request.id, command: request.type, success: true, data });
    const sessionFile = () => current ? `C:/sessions/${current}.jsonl` : "C:/sessions/new.jsonl";
    const review = { ok: true, action: "inspect", sessionId: ids[2], mode: "on", items: [{ id: "metrics-review", withheld: true, ticket: "ticket", source: "SKILL.md", digest: "a".repeat(64), severity: "error", review: { source: "SKILL.md", digest: "a".repeat(64), scanner: "fixture", status: "withheld", severity: { error: 1 }, findings: [{ kind: "yara:command_injection" }] }, snapshot: { body: "reviewed body" } }] };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback() {},
      invoke: async (command: string, args: any) => {
        if (command === "launcher_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: "C:/Projects/Metrics", environment: { kind: "windows" } }] };
        if (command === "control_request") return { schemaVersion: 1, modelReady: true, profile: "core", account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
        if (command === "component_versions") return { jouzu: "0.3.8", development: true };
        if (command === "chat_sessions") return sessions;
        if (command === "chat_session_messages") return histories[String(args.sessionPath)] ?? [];
        if (command === "textguard_reviews_read") return String(args.sessionId) === ids[2] ? review : null;
        if (command === "textguard_reviews_write" || command === "textguard_reviews_clear") return null;
        if (command === "chat_flow_reports") return [];
        if (command === "chat_session_timing") return { modelMs: 1, toolMs: 1, turns: 1, steps: 1, outputTokens: 1 };
        if (command === "environment_read") return [];
        if (command === "chat_start") return "metrics-test";
        if (command === "chat_poll") return { records: records.splice(0), closed: false };
        if (command === "chat_send") {
          const request = args.request;
          if (request.type === "switch_session") { w.switchCalls.push(request.sessionPath); current = String(request.sessionPath).replace(/^.*[\\/]|\.jsonl$/g, ""); response(request, { cancelled: false }); }
          else if (request.type === "new_session") { current = ""; response(request, { cancelled: false }); }
          else if (request.type === "get_state") response(request, { sessionId: current || "new", sessionFile: sessionFile(), isStreaming: false, model: { name: "Metrics model" } });
          else if (request.type === "get_messages") response(request, { messages: histories[sessionFile()] ?? [] });
          else if (request.type === "get_available_models") response(request, { models: [{ provider: "fixture", id: "deterministic", name: "Metrics model" }] });
          else if (request.type === "get_available_thinking_levels") response(request, { levels: [] });
          else if (request.type === "get_session_stats") response(request, { userMessages: 1, assistantMessages: 1, toolCalls: 0, tokens: { total: 1 } });
          else response(request);
          return;
        }
        if (command.includes("version")) return "0.3.8";
        return 1;
      },
    };
  }, { ids, paths, histories: Object.fromEntries(paths.map((path, index) => [path, history(index)])) });
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

async function measure(page: Page, headerTitle: string, expected: string) {
  await page.evaluate(({ headerTitle, expected }) => {
    const state: any = { start: 0, selection: null, content: null, settled: null, blankFrames: 0, staleFrames: 0, frames: 0, headerTitle, expected };
    (window as any).__sessionMetric = state;
    const articles = () => document.querySelectorAll("article").length;
    const selectedTitle = () => document.querySelector("h2")?.textContent ?? "";
    let firstContent = false;
    let lastChange = 0;
    let lastArticles = -1;
    let done = false;
    const tick = (now: number) => {
      if (!state.start || done) return;
      state.frames += 1;
      const count = articles();
      if (!firstContent && selectedTitle().includes(headerTitle)) state.selection ??= now - state.start;
      if (!firstContent && !document.body.innerText.includes(expected) && count === 0) state.blankFrames += 1;
      if (!firstContent && !selectedTitle().includes(headerTitle)) state.staleFrames += 1;
      if (!firstContent && document.body.innerText.includes(expected)) { firstContent = true; state.content = now - state.start; lastChange = now; }
      if (lastArticles !== count) { lastArticles = count; lastChange = now; }
      if (firstContent && now - lastChange > 80) { state.settled = now - state.start; done = true; return; }
      if (now - state.start > 1500) { state.settled = now - state.start; done = true; return; }
      requestAnimationFrame(tick);
    };
    document.addEventListener("click", event => {
      const button = (event.target as Element | null)?.closest("button[title]");
      if (!button) return;
      state.start = performance.now();
      const observer = new MutationObserver(() => {
        if (state.selection === null && selectedTitle().includes(headerTitle)) state.selection = performance.now() - state.start;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      setTimeout(() => observer.disconnect(), 1500);
      requestAnimationFrame(tick);
    }, { capture: true, once: true });
  }, { headerTitle, expected });
  await page.getByRole("button", { name: new RegExp(`^${headerTitle}\\b`) }).click();
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const state = (window as any).__sessionMetric;
    const scroll = document.querySelector('section[aria-label="Conversation"] .overflow-y-auto');
    return {
      ...state,
      articles: document.querySelectorAll("article").length,
      scrollGap: scroll ? Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) : null,
    };
  });
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
  return { median: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10, max: Math.round((sorted.at(-1) ?? 0) * 10) / 10 };
}

test("master metrics: sampled open and switch measurements", async ({ page }) => {
  await setup(page);
  const cases = [
    { title: "S1", expected: "short answer", label: "short" },
    { title: "S2", expected: "textguard answer", label: "textguard" },
    { title: "S3", expected: "long turn 79", label: "long-160" },
    { title: "S0", expected: "What would you like to work on?", label: "empty" },
  ];
  const samples: Record<string, any[]> = {};
  for (const item of cases) {
    samples[item.label] = [];
    for (let run = 0; run < 6; run += 1) {
      await page.getByRole("button", { name: /^S7\b/ }).click();
      await page.waitForTimeout(120);
      const metric = await measure(page, item.title, item.expected);
      samples[item.label].push(metric);
    }
  }
  const sequence: any[] = [];
  for (let index = 0; index < 10; index += 1) {
    const first = index % 2 === 0;
    sequence.push(await measure(page, first ? "S1" : "S2", first ? "short answer" : "textguard answer"));
    await page.waitForTimeout(80);
  }
  samples.alternating = sequence;
  const switchCalls = await page.evaluate(() => (window as any).switchCalls.length);
  const summary = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, {
    samples: values.length,
    selectionMs: stats(values.map(value => value.selection ?? 0)),
    contentMs: stats(values.map(value => value.content ?? 0)),
    settledMs: stats(values.map(value => value.settled ?? 0)),
    blankFrames: stats(values.map(value => value.blankFrames)),
    staleFrames: stats(values.map(value => value.staleFrames)),
    scrollGap: stats(values.map(value => value.scrollGap ?? 0)),
  }]));
  const result = { generatedAt: new Date().toISOString(), summary, raw: samples, switchCalls };
  await mkdir(resolve("test-results"), { recursive: true });
  await writeFile(resolve("test-results/session-metrics.json"), JSON.stringify(result, null, 2));
  console.log("SESSION_METRICS", JSON.stringify(summary, null, 2));
  expect(switchCalls).toBe(0);
});
