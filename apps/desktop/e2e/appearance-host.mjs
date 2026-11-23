// A scripted host for appearance screenshots. It serves the built app and just enough of
// the /v1 contract for one saved session with a fixed transcript. Not used by the app.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const dist = resolve("dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const session = {
  sessionId: "s1",
  sessionPath: "C:/sessions/s1.jsonl",
  workspacePath: "C:/Projects/Example",
  title: "Ink and paper",
  status: "idle",
  updatedAt: new Date().toISOString(),
  running: false,
  pinned: false,
  archived: false,
};
const model = { state: "ready", name: "Fixture model", provider: "fixture", id: "deterministic" };
// The host answers newest first; the transcript renders oldest first.
const transcript = [
  { cursor: 1, id: "u1", kind: "user", turnId: "t1", createdAt: "2026-11-21T08:00:00.000Z", blocks: [{ type: "text", text: "Restyle the app with a quieter palette" }] },
  { cursor: 2, id: "a1", kind: "assistant", turnId: "t1", model: "deterministic", provider: "fixture", createdAt: "2026-11-21T08:00:01.000Z", blocks: [
    { type: "thinking", text: "Considering the palette and the contrast between the two surfaces." },
    { type: "text", text: "The theme now uses **one accent** and a quiet neutral ramp. Here is the token block:\n\n```css\n@theme {\n  --color-background: #131312;\n  --color-primary: #8fa2ff;\n}\n```\n\n- Borders are hairlines, not boxes.\n- Surfaces step by lightness, not by glow." },
  ] },
  { cursor: 3, id: "u2", kind: "user", turnId: "t2", createdAt: "2026-11-21T08:01:00.000Z", blocks: [{ type: "text", text: "Keep the mark as the only saturated colour." }] },
  { cursor: 4, id: "a2", kind: "assistant", turnId: "t2", model: "deterministic", provider: "fixture", createdAt: "2026-11-21T08:01:02.000Z", blocks: [
    { type: "text", text: "Done. The interface is now graphite and paper; the cyan–violet JZ mark is the one place colour is allowed to shout." },
  ] },
].reverse();

const api = (path, method) => {
  if (path === "capabilities") return { features: ["chat", "sse", "replay", "prompts", "history-paging"], scopes: ["loopback"] };
  if (path === "app") return { revision: 1, config: { running: null, queued: [], lastResult: {} }, settings: null };
  if (path === "status") return { hostVersion: "0.2.5", runtimeHome: "C:/runtime", appVersion: "1.1.4", node: true, app: true, bash: true, git: true, terminal: true };
  if (path === "runtime/warm") return { state: "ready" };
  if (path === "sessions" && method === "POST") return { ...session, status: "ready", cursor: 4, model };
  if (path === "sessions/persisted") return { sessions: [session] };
  if (path === "sessions") return { sessions: [] };
  if (path === "sessions/s1/messages") return { messages: transcript, nextBefore: null };
  if (path === "sessions/s1/stats") return { userMessages: 2, assistantMessages: 2, toolCalls: 1, tokens: { input: 200, output: 100, cacheRead: 700, cacheWrite: 0, total: 1000 }, contextUsage: { percent: 42, tokens: 42000, contextWindow: 100000 } };
  if (path === "sessions/s1/snapshot") return { cursor: 4, model };
  if (path === "sessions/flow") return { reports: [] };
  if (path === "sessions/timing") return { timing: null };
  if (path === "models") return { models: [{ id: "deterministic", name: "Fixture model", provider: "fixture" }] };
  if (path === "environment") return { entries: [] };
  if (path === "workspaces") return { workspaces: [{ id: "work", path: "C:/Projects/Example", environment: { kind: "windows" } }] };
  return {};
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/v1/")) {
    if (url.pathname === "/v1/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(": open\n\n");
      const timer = setInterval(() => response.write(": ping\n\n"), 5000);
      request.on("close", () => clearInterval(timer));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(api(url.pathname.slice(4), request.method)));
    return;
  }
  const file = resolve(dist, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
  if (!file.startsWith(dist + sep)) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
server.listen(Number(process.argv[2] ?? 4317), "127.0.0.1", () => {
  const address = server.address();
  console.log(`theme host on http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
});