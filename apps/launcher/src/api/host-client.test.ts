import { describe, expect, test } from "vitest";
import { HostClient } from "./host-client";
import { ApiError } from "./jouzu-api";

type Call = { url: string; init?: RequestInit };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HostClient", () => {
  test("merges live and persisted sessions with canonical dedupe", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v1/sessions")) {
        return response({ sessions: [{ sessionId: "h1", workspacePath: "C:/w", sessionPath: "C:/s/one.jsonl", title: "one", status: "idle", running: false }] });
      }
      if (String(input).endsWith("/v1/sessions/persisted")) {
        return response({ sessions: [{ sessionId: null, workspacePath: "C:/w", sessionPath: "C:/s/one.jsonl", title: "one", status: "stopped", running: false }, { sessionId: null, workspacePath: "C:/w2", sessionPath: "C:/s/two.jsonl", title: "two", status: "stopped", running: false }] });
      }
      return response({});
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "http://host", fetchImpl });
    const sessions = await client.sessions();
    expect(sessions).toHaveLength(2);
    expect(calls.map(call => call.url)).toEqual(["http://host/v1/sessions", "http://host/v1/sessions/persisted"]);
  });

  test("sends attachments and a client id", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return response({ messageId: "m-1", receipt: "queued" }, 202);
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "", clientId: "web-test", fetchImpl });
    await client.send("h1", "hello", "c-1", [{ name: "a.png", mimeType: "image/png", data: "AA==" }]);
    expect(body).toEqual({
      clientMessageId: "c-1",
      text: "hello",
      clientId: "web-test",
      attachments: [{ name: "a.png", mimeType: "image/png", data: "AA==" }],
    });
  });

  test("opens a session as this client, so the host keeps it while it is open", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return response({ sessionId: "h1", status: "starting", cursor: 0 }, 202);
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "", clientId: "web-test", fetchImpl });
    await client.attach("C:/w", "C:/s/one.jsonl");
    expect(body).toEqual({ workspacePath: "C:/w", sessionPath: "C:/s/one.jsonl", clientId: "web-test" });
  });

  test("uses model and thinking endpoints", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v1/models")) {
        return response({ models: [{ provider: "fixture", id: "model", name: "Fixture" }] });
      }
      return response({});
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "http://host", fetchImpl });
    expect((await client.models()).models[0].id).toBe("model");
    await client.selectModel("h1", "fixture", "model");
    await client.setThinking("h1", "high");
    expect(calls.map(call => call.url)).toEqual([
      "http://host/v1/models",
      "http://host/v1/sessions/h1/model",
      "http://host/v1/sessions/h1/thinking",
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ provider: "fixture", model: "model" });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ level: "high" });
  });

  test("uses tools and MCP endpoints", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v1/tools/providers")) return response({ providers: [{ id: "shisa", label: "Shisa" }] });
      if (String(input).includes("/v1/tools/models")) return response({ models: ["m"] });
      if (String(input).endsWith("/v1/mcp")) return response({ path: "mcp.json", exists: false, servers: [] });
      if (String(input).endsWith("/v1/tools")) return response({ path: "tools.json", exists: false, settings: {} });
      return response({});
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "http://host", fetchImpl });
    await client.tools();
    await client.saveTools({ provider: "shisa" });
    await client.toolProviders();
    await client.toolModels("shisa");
    await client.mcp();
    expect(calls.map(call => call.url)).toEqual([
      "http://host/v1/tools",
      "http://host/v1/tools",
      "http://host/v1/tools/providers",
      "http://host/v1/tools/models?provider=shisa",
      "http://host/v1/mcp",
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ image: { provider: "shisa" } });
  });

  test("unwraps session stats and maps error envelopes", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/sessions/h1/stats")) {
        return response({ stats: null });
      }
      return response({ error: { code: "prompt-resolved", message: "already", retryable: false } }, 409);
    }) as typeof fetch;
    const client = new HostClient({ fetchImpl });
    await expect(client.stats("h1")).resolves.toBeNull();
    await expect(client.approve("a1", "Approve")).rejects.toMatchObject<Partial<ApiError>>({
      code: "prompt-resolved",
      retryable: false,
      status: 409,
    });
  });

  test("streams SSE events and sends the cursor", async () => {
    let url = "";
    let cursor = "";
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("id: 4\nevent: message.delta\ndata: {\"text\":\"h\"}\n\n"));
        controller.enqueue(encoder.encode("id: 5\nevent: message.done\ndata: {\"stopReason\":\"completed\"}\n\n"));
        controller.close();
      },
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      cursor = String((init?.headers as Record<string, string> | undefined)?.["last-event-id"] ?? "");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "http://host", fetchImpl });
    const events: Array<{ id: number; event: string }> = [];
    client.subscribe("h1", "web-test", ["view", "prompts"], 3, event => events.push({ id: event.id, event: event.event }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(url).toContain("/v1/sessions/h1/events?");
    expect(url).toContain("clientId=web-test");
    expect(cursor).toBe("3");
    expect(events).toEqual([
      { id: 4, event: "message.delta" },
      { id: 5, event: "message.done" },
    ]);
  });
  test("registers prompt capabilities on the global event stream", async () => {
    let url = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new HostClient({ baseUrl: "http://host", fetchImpl });
    const stop = client.subscribeEvents("ui-1", 0, () => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    stop();
    const query = new URL(url).searchParams;
    expect(query.get("clientId")).toBe("ui-1");
    expect(query.get("capabilities")?.split(",")).toEqual(expect.arrayContaining(["prompts", "control"]));
  });
});
