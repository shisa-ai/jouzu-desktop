// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { availability, listModels, listProviders, setCredentialReader, setRegistryLoader } from "../../../packaging/desktop/extensions/jouzu-image/index.js";
import shisa from "../../../packaging/desktop/extensions/jouzu-image/providers/shisa.mjs";

function load() {
  const tools = [];
  const handlers = new Map();
  extension({
    registerTool: tool => tools.push(tool),
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  return { tool: tools[0], handlers };
}

function homeWith(settings) {
  const home = mkdtempSync(join(tmpdir(), "jouzu-image-"));
  mkdirSync(join(home, "agent"), { recursive: true });
  if (settings) writeFileSync(join(home, "agent", "tools.json"), JSON.stringify(settings));
  return home;
}

// A PNG header is enough for the artifact dimension reader.
function png(width, height, payload = "x") {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([header, size, Buffer.from(payload)]);
}

const bytes = png(2816, 1536);
const imageBody = () => ({ steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: bytes.toString("base64") }] }] });
const ok = body => ({ ok: true, status: 200, json: async () => body });

// The runtime's model registry, reduced to what the extension uses.
const flux = { type: "image", id: "black-forest-labs/flux.2-pro", provider: "openrouter", api: "openrouter-images" };
const gemini = { type: "image", id: "google/gemini-2.5-flash-image", provider: "openrouter", api: "openrouter-images" };
function registry({ models = [], available = models, generateImages } = {}) {
  return {
    getModelsOfType: (_type, provider) => models.filter(model => !provider || model.provider === provider),
    getAvailableOfType: async (_type, provider) => available.filter(model => !provider || model.provider === provider),
    getProviderDisplayName: id => (id === "openrouter" ? "OpenRouter" : id),
    generateImages: generateImages ?? vi.fn(),
  };
}
const runtimeImage = () => ({ stopReason: "stop", output: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] });

describe("generate_image extension", () => {
  let home = null;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    setCredentialReader(async () => ({ type: "oauth", access: "test-token" }));
    // By default the runtime lists no image models, so only the own Shisa adapter applies.
    setRegistryLoader(async () => registry());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
    delete process.env.JOUZU_HOME;
  });

  it("registers one tool with a count, and a review handler", () => {
    const { tool, handlers } = load();
    expect(tool.name).toBe("generate_image");
    expect(Object.keys(tool.parameters.properties)).toEqual(["prompt", "count", "provider", "model", "size"]);
    expect(handlers.get("tool_call")).toHaveLength(1);
  });

  it("blocks a reviewed call when denied, and never reaches the provider", async () => {
    home = homeWith({ image: { provider: "shisa", model: "m1", size: "1K" }, reviewTools: ["generate_image"] });
    process.env.JOUZU_HOME = home;
    const { handlers } = load();
    const ctx = { ui: { select: vi.fn().mockResolvedValue("Deny") } };
    const result = await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "a cat" } }, ctx);
    expect(result).toMatchObject({ block: true });
    expect(fetch).not.toHaveBeenCalled();
    // Denying again simply asks again; the user may refuse as often as they like.
    await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "a cat" } }, ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
  });

  it("names the prompt and the number of paid generations in the review", async () => {
    home = homeWith({ image: { provider: "shisa", model: "gemini-3-pro-image", size: "2K" } });
    process.env.JOUZU_HOME = home;
    const { handlers } = load();
    const select = vi.fn().mockResolvedValue("Deny");
    await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "三只猫", count: 3 } }, { ui: { select } });
    const title = select.mock.calls[0][0];
    const body = JSON.parse(title.split("\n")[1]);
    expect(body.images).toBe(3);
    expect(body.prompt).toBe("三只猫");
    expect(body.provider).toBe("shisa");
  });

  it("remembers 'approve for this session' until the session restarts", async () => {
    home = homeWith({ reviewTools: ["generate_image"] });
    process.env.JOUZU_HOME = home;
    const { handlers } = load();
    const select = vi.fn().mockResolvedValue("Approve for this session");
    const ctx = { ui: { select } };
    await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "a cat" } }, ctx);
    await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "a cat" } }, ctx);
    expect(select).toHaveBeenCalledTimes(1);
    await handlers.get("session_start")[0]({}, {});
    await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "a cat" } }, ctx);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("saves one artifact with its prompt and dimensions, and returns the image", async () => {
    home = homeWith({ image: { provider: "shisa", model: "gemini-3-pro-image", size: "2K" } });
    process.env.JOUZU_HOME = home;
    vi.mocked(fetch).mockResolvedValue(ok(imageBody()));
    const { tool } = load();
    const result = await tool.execute("call-1", { prompt: "a cat" });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.model).toBe("gemini-3-pro-image");
    expect(body.response_format.image_size).toBe("2K");
    expect(result.content.filter(block => block.type === "image")).toHaveLength(1);
    expect(result.content[0].text).toContain('Prompt: "a cat"');
    expect(result.details).toMatchObject({ prompt: "a cat", provider: "shisa", model: "gemini-3-pro-image", size: "2K", usage: null });
    expect(result.details.images).toHaveLength(1);
    const image = result.details.images[0];
    expect(image.width).toBe(2816);
    expect(image.height).toBe(1536);
    expect(image.path.endsWith(`${image.id}.png`)).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(home, "artifacts", "images", `${image.id}.json`), "utf8"));
    expect(sidecar).toMatchObject({ kind: "images", prompt: "a cat", prompts: ["a cat"], mimeType: "image/png" });
    expect(sidecar.source.tool).toBe("generate_image");
  });

  it("defaults to the provider's first model instead of failing on an unset model", async () => {
    home = homeWith({ image: { provider: "shisa", model: "", size: "1K" } });
    process.env.JOUZU_HOME = home;
    vi.mocked(fetch).mockResolvedValueOnce(ok({ models: [{ name: "models/first-model" }] })).mockResolvedValueOnce(ok(imageBody()));
    const { tool } = load();
    await tool.execute("call", { prompt: "a cat" });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1].body).model).toBe("first-model");
  });

  it("generates the requested count and caps it by the settings", async () => {
    home = homeWith({ image: { provider: "shisa", model: "m1", size: "1K", maxImages: 2 } });
    process.env.JOUZU_HOME = home;
    vi.mocked(fetch).mockResolvedValue(ok(imageBody()));
    const { tool } = load();
    const result = await tool.execute("call", { prompt: "a cat", count: 5 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.details.images).toHaveLength(2);
    expect(result.content.filter(block => block.type === "image")).toHaveLength(2);
  });

  it("reuses the artifact id for identical bytes and appends the prompt", async () => {
    home = homeWith({ image: { provider: "shisa", model: "m1", size: "1K" } });
    process.env.JOUZU_HOME = home;
    vi.mocked(fetch).mockResolvedValue(ok(imageBody()));
    const { tool } = load();
    const first = await tool.execute("call-1", { prompt: "a cat" });
    const second = await tool.execute("call-2", { prompt: "a cat again" });
    expect(second.details.images[0].id).toBe(first.details.images[0].id);
    const files = readdirSync(join(home, "artifacts", "images")).filter(name => name.endsWith(".png"));
    expect(files).toHaveLength(1);
    const sidecar = JSON.parse(readFileSync(join(home, "artifacts", "images", `${first.details.images[0].id}.json`), "utf8"));
    expect(sidecar.prompts).toEqual(["a cat", "a cat again"]);
  });

  it("reports a missing runtime credential as a sign-in problem", async () => {
    home = homeWith({ image: { provider: "shisa", model: "m1", size: "1K" } });
    process.env.JOUZU_HOME = home;
    setCredentialReader(async () => undefined);
    const { tool } = load();
    await expect(tool.execute("call", { prompt: "a cat" })).rejects.toThrow("Sign in to Shisa.AI");
  });

  it("falls back to a size the chosen model accepts", async () => {
    home = homeWith({ image: { provider: "shisa", model: "gemini-3.1-flash-lite-image", size: "1K" } });
    process.env.JOUZU_HOME = home;
    vi.mocked(fetch).mockResolvedValue(ok(imageBody()));
    const { tool } = load();
    const result = await tool.execute("call", { prompt: "a cat", size: "4K" });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1].body).response_format.image_size).toBe("1K");
    expect(result.details.size).toBe("1K");
  });

  it("lists the runtime's image providers beside Shisa, each usable with its models or with the reason it is not", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ models: [{ name: "models/gemini-3.1-flash-lite-image" }] }));
    const providers = await listProviders(registry({ models: [flux, gemini], available: [] }));
    expect(providers).toEqual([
      { id: "shisa", label: "Shisa.AI", available: true, models: [{ id: "gemini-3.1-flash-lite-image", sizes: ["1K"] }] },
      { id: "openrouter", label: "OpenRouter", available: false, code: "no-credential", reason: "No credential for OpenRouter. Add one under Model providers to generate images with it." },
    ]);
    const usable = await listProviders(registry({ models: [flux, gemini] }));
    // The runtime's image API takes no size, so its models offer none.
    expect(usable[1]).toEqual({ id: "openrouter", label: "OpenRouter", available: true, models: [{ id: flux.id, sizes: [] }, { id: gemini.id, sizes: [] }] });
    const models = await listModels(registry({ models: [flux, gemini] }), "openrouter");
    expect(models).toEqual([{ id: flux.id, sizes: [] }, { id: gemini.id, sizes: [] }]);
  });

  it("marks Shisa unavailable without a credential, with the reason, instead of hiding it", async () => {
    setCredentialReader(async () => undefined);
    const providers = await listProviders(registry());
    expect(providers).toEqual([{ id: "shisa", label: "Shisa.AI", available: false, code: "no-credential", reason: "Sign in to Shisa.AI or set SHISA_API_KEY to generate images." }]);
  });

  it("generates with a runtime provider through the runtime's registry, never its own request", async () => {
    home = homeWith({ image: { provider: "openrouter", model: gemini.id, size: "2K", maxImages: 2 } });
    process.env.JOUZU_HOME = home;
    const generateImages = vi.fn().mockResolvedValue(runtimeImage());
    const modelRegistry = registry({ models: [flux, gemini], generateImages });
    const { tool } = load();
    const result = await tool.execute("call", { prompt: "a cat", count: 2 }, undefined, undefined, { modelRegistry });
    expect(fetch).not.toHaveBeenCalled();
    expect(generateImages).toHaveBeenCalledTimes(2);
    expect(generateImages.mock.calls[0][0]).toBe(gemini);
    expect(generateImages.mock.calls[0][1]).toEqual({ input: [{ type: "text", text: "a cat" }] });
    expect(result.details).toMatchObject({ provider: "openrouter", model: gemini.id, size: null });
    expect(result.details.images).toHaveLength(2);
    expect(result.content[0].text).not.toContain("Size:");
    const sidecar = JSON.parse(readFileSync(join(home, "artifacts", "images", `${result.details.images[0].id}.json`), "utf8"));
    expect(sidecar.source).toMatchObject({ provider: "openrouter", model: gemini.id });
  });

  it("starts from the requested provider's first model, not the configured provider's model", async () => {
    home = homeWith({ image: { provider: "shisa", model: "gemini-3-pro-image", size: "1K" } });
    process.env.JOUZU_HOME = home;
    const generateImages = vi.fn().mockResolvedValue(runtimeImage());
    const { tool } = load();
    const result = await tool.execute("call", { prompt: "a cat", provider: "openrouter" }, undefined, undefined, { modelRegistry: registry({ models: [flux, gemini], generateImages }) });
    expect(generateImages.mock.calls[0][0]).toBe(flux);
    expect(result.details.model).toBe(flux.id);
  });

  it("names the missing credential of a runtime provider instead of failing silently", async () => {
    home = homeWith({ image: { provider: "openrouter", model: flux.id } });
    process.env.JOUZU_HOME = home;
    const generateImages = vi.fn();
    const { tool } = load();
    await expect(tool.execute("call", { prompt: "a cat" }, undefined, undefined, { modelRegistry: registry({ models: [flux], available: [], generateImages }) }))
      .rejects.toThrow("No credential for OpenRouter");
    expect(generateImages).not.toHaveBeenCalled();
  });

  it("reports the runtime's own error for a failed generation", async () => {
    home = homeWith({ image: { provider: "openrouter", model: flux.id } });
    process.env.JOUZU_HOME = home;
    const generateImages = vi.fn().mockResolvedValue({ stopReason: "error", output: [], errorMessage: "402 Insufficient credits" });
    const { tool } = load();
    await expect(tool.execute("call", { prompt: "a cat" }, undefined, undefined, { modelRegistry: registry({ models: [flux], generateImages }) }))
      .rejects.toThrow("402 Insufficient credits");
  });

  it("does not name a size in the review of a runtime provider's call", async () => {
    home = homeWith({ image: { provider: "openrouter", model: flux.id, size: "2K" } });
    process.env.JOUZU_HOME = home;
    const { handlers } = load();
    const select = vi.fn().mockResolvedValue("Deny");
    await handlers.get("tool_call")[0]({ toolName: "generate_image", input: { prompt: "a cat" } }, { ui: { select }, modelRegistry: registry({ models: [flux] }) });
    const body = JSON.parse(select.mock.calls[0][0].split("\n")[1]);
    expect(body).toMatchObject({ provider: "openrouter", model: flux.id });
    expect(body).not.toHaveProperty("size");
  });

  it("refuses a provider neither the runtime nor the desktop knows", async () => {
    home = homeWith({ image: { provider: "nobody" } });
    process.env.JOUZU_HOME = home;
    const { tool } = load();
    await expect(tool.execute("call", { prompt: "a cat" }, undefined, undefined, { modelRegistry: registry({ models: [flux] }) })).rejects.toThrow("Unknown image provider: nobody");
  });
});

// #64: the Tools page offers a provider only when it can generate images now.
describe("image provider availability", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("is unavailable without a credential, and says how to get one", async () => {
    setCredentialReader(async () => undefined);
    const result = await availability(shisa);
    expect(result).toEqual({ available: false, code: "no-credential", reason: "Sign in to Shisa.AI or set SHISA_API_KEY to generate images." });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says a refused sign-in by its code, for the desktop to word", async () => {
    setCredentialReader(async () => ({ type: "oauth", access: "expired" }));
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await availability(shisa)).toEqual({ available: false, code: "sign-in-refused", reason: "Sign in to Shisa.AI again to generate images." });
  });

  it("reads the router's error code before its status", async () => {
    setCredentialReader(async () => ({ type: "oauth", access: "t" }));
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "model_not_in_plan" } }) });
    expect(await availability(shisa)).toMatchObject({ available: false, code: "not-allowed" });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { code: "free_allowance_exhausted" } }) });
    expect(await availability(shisa)).toMatchObject({ available: false, code: "no-credit" });
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 402, json: async () => ({ error: { code: "insufficient_balance" } }) });
    expect(await availability(shisa)).toMatchObject({ available: false, code: "no-credit" });
  });

  it("is unavailable when the account cannot use image generation", async () => {
    setCredentialReader(async () => ({ type: "oauth", access: "t" }));
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, json: async () => ({ code: 311 }) });
    expect(await availability(shisa)).toEqual({ available: false, code: "not-allowed", reason: "This account cannot use image generation (shisa/image)." });
  });

  it("is unavailable when the account lists no image models", async () => {
    setCredentialReader(async () => ({ type: "oauth", access: "t" }));
    vi.mocked(fetch).mockResolvedValue(ok({ models: [] }));
    expect(await availability(shisa)).toEqual({ available: false, code: "no-models", reason: "This account has no image models." });
  });

  it("is unavailable, not an error, when the provider cannot be reached", async () => {
    setCredentialReader(async () => ({ type: "oauth", access: "t" }));
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    expect(await availability(shisa)).toEqual({ available: false, code: "unreachable", reason: "Shisa.AI could not be reached." });
  });

  it("is available with the account's models and their sizes", async () => {
    setCredentialReader(async () => ({ type: "oauth", access: "t" }));
    vi.mocked(fetch).mockResolvedValue(ok({ models: [{ name: "models/gemini-3.1-flash-lite-image" }] }));
    expect(await availability(shisa)).toEqual({ available: true, models: [{ id: "gemini-3.1-flash-lite-image", sizes: ["1K"] }] });
  });
});

// The Shisa credential follows Jouzu's rule: sign-out, then SHISA_API_KEY, then an unexpired sign-in.
describe("Shisa credential", () => {
  const runtime = ({ signedOut = false, login = undefined } = {}) => async () => ({
    isShisaSignedOut: () => signedOut,
    readShisaLoginToken: () => login,
  });

  it("prefers SHISA_API_KEY over a sign-in", async () => {
    const credential = await shisa.credential({ env: { SHISA_API_KEY: " key " }, agentDir: "a", runtimeModule: runtime({ login: "login" }) });
    expect(credential).toEqual({ type: "api_key", key: "key" });
  });

  it("uses the runtime's sign-in token, which is absent once expired", async () => {
    expect(await shisa.credential({ env: {}, agentDir: "a", runtimeModule: runtime({ login: "login" }) })).toEqual({ type: "oauth", access: "login" });
    expect(await shisa.credential({ env: {}, agentDir: "a", runtimeModule: runtime() })).toBeUndefined();
  });

  it("has no credential after a local sign-out, even with SHISA_API_KEY", async () => {
    expect(await shisa.credential({ env: { SHISA_API_KEY: "key" }, agentDir: "a", runtimeModule: runtime({ signedOut: true, login: "login" }) })).toBeUndefined();
  });
});
