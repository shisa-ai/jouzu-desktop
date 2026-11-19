// Jouzu Desktop's image generation tool. Installed into the agent's extension
// directory by the desktop; it is not part of the runtime.
//
// Authorization is the runtime's: the credential is read through the runtime's
// own API, never from a file we parse, and this tool never refreshes or stores it.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { saveArtifact } from "./artifacts.mjs";
import shisa from "./providers/shisa.mjs";
import { generateWithRuntime, hasRuntimeProvider, listRuntimeModels, listRuntimeProviders } from "./providers/runtime.mjs";

// Image providers come from the runtime's model catalog (providers/runtime.mjs).
// The adapters here only cover providers whose image API the runtime does not
// list yet; a runtime provider with the same id always takes precedence.
const OWN_PROVIDERS = { [shisa.id]: shisa };
const SIZES = ["1K", "2K", "4K"];
const DEFAULT_PROVIDER = "shisa";
const DEFAULT_SIZE = "1K";
const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_REVIEW = ["generate_image"];

export function home() {
  return process.env.JOUZU_HOME || join(process.env.LOCALAPPDATA || process.cwd(), "Shisa.ai", "JouzuDesktop", "data");
}

export function settingsPath() {
  return join(home(), "agent", "tools.json");
}

function maxImages(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(10, Math.max(1, Math.trunc(number))) : DEFAULT_MAX_IMAGES;
}

export async function settings() {
  try {
    const value = JSON.parse(await readFile(settingsPath(), "utf8"));
    return {
      image: {
        enabled: value?.image?.enabled !== false,
        provider: typeof value?.image?.provider === "string" ? value.image.provider : DEFAULT_PROVIDER,
        model: typeof value?.image?.model === "string" ? value.image.model : "",
        size: SIZES.includes(value?.image?.size) ? value.image.size : DEFAULT_SIZE,
        maxImages: maxImages(value?.image?.maxImages),
      },
      reviewTools: Array.isArray(value?.reviewTools) ? value.reviewTools.filter(item => typeof item === "string") : DEFAULT_REVIEW,
    };
  } catch {
    // Until the Tools page exists, the pre-Tools settings file still applies.
    try {
      const legacy = JSON.parse(await readFile(join(home(), "agent", "image-generation.json"), "utf8"));
      return {
        image: {
          enabled: true,
          provider: DEFAULT_PROVIDER,
          model: typeof legacy.model === "string" ? legacy.model : "",
          size: SIZES.includes(legacy.size) ? legacy.size : DEFAULT_SIZE,
          maxImages: DEFAULT_MAX_IMAGES,
        },
        reviewTools: DEFAULT_REVIEW,
      };
    } catch {
      return {
        image: { enabled: true, provider: DEFAULT_PROVIDER, model: "", size: DEFAULT_SIZE, maxImages: DEFAULT_MAX_IMAGES },
        reviewTools: DEFAULT_REVIEW,
      };
    }
  }
}

/**
 * Load a module from the runtime's installation. Node resolves bare imports
 * relative to this extension file, which is outside the app's node_modules, so
 * the runtime package is resolved from the app directory instead: the running
 * runtime's own (its bootstrap script), or, for the CLI below, the one the
 * desktop host starts (JOUZU_RUNTIME_APP). The data home says nothing about
 * where the app is: a custom JOUZU_HOME can be anywhere.
 */
async function runtimeModule(relative) {
  const roots = [];
  const bootstrap = process.argv[1];
  if (typeof bootstrap === "string" && /bootstrap\.mjs$/.test(bootstrap)) roots.push(dirname(bootstrap));
  if (process.env.JOUZU_RUNTIME_APP) roots.push(process.env.JOUZU_RUNTIME_APP);
  for (const root of roots) {
    const file = join(root, "node_modules", relative);
    if (existsSync(file)) return import(pathToFileURL(file).href);
  }
  throw new Error("The runtime's coding-agent package could not be found.");
}

/**
 * The provider's credential, read the way the runtime reads it. A provider that
 * knows its runtime's rule (Shisa: SHISA_API_KEY, then an unexpired sign-in)
 * resolves it itself; any other provider uses the runtime's stored credential.
 * Injectable so the tests do not need the runtime.
 */
let credentialReader = async providerId => {
  // The runtime sets PI_CODING_AGENT_DIR; the CLI mode sets it from JOUZU_HOME.
  process.env.PI_CODING_AGENT_DIR ||= join(home(), "agent");
  const provider = OWN_PROVIDERS[providerId];
  if (provider?.credential) {
    return provider.credential({ env: process.env, agentDir: process.env.PI_CODING_AGENT_DIR, runtimeModule });
  }
  const { readStoredCredential } = await runtimeModule("@earendil-works/pi-coding-agent/dist/index.js");
  return readStoredCredential(providerId);
};

export function setCredentialReader(reader) {
  credentialReader = reader;
}

/**
 * The runtime's model registry. Inside a session it is `ctx.modelRegistry`; the
 * Tools page (CLI mode) builds one from the same agent directory, so both see
 * the same catalog, models.json and credentials. Injectable for the tests.
 */
let registryLoader = async () => {
  process.env.PI_CODING_AGENT_DIR ||= join(home(), "agent");
  const { ModelRegistry, ModelRuntime } = await runtimeModule("@earendil-works/pi-coding-agent/dist/index.js");
  return new ModelRegistry(await ModelRuntime.create({}));
};

export function setRegistryLoader(loader) {
  registryLoader = loader;
}

async function registryFor(ctx) {
  return ctx?.modelRegistry ?? registryLoader();
}

/**
 * Every image provider with whether it can generate images now, and why not:
 * own adapters first, then the runtime's. A usable provider carries its models.
 */
export async function listProviders(registry) {
  const runtime = await listRuntimeProviders(registry);
  const listed = new Set(runtime.map(provider => provider.id));
  const own = await Promise.all(Object.values(OWN_PROVIDERS)
    .filter(provider => !listed.has(provider.id))
    .map(async provider => ({ id: provider.id, label: provider.label ?? provider.id, ...(await availability(provider)) })));
  const fromRuntime = runtime.map(provider => provider.available
    ? { ...provider, models: listRuntimeModels(registry, provider.id) }
    : { ...provider, code: "no-credential", reason: `No credential for ${provider.label}. Add one under Model providers to generate images with it.` });
  return [...own, ...fromRuntime];
}

export async function token(providerId) {
  const credential = await credentialReader(providerId);
  const value = credential?.access ?? credential?.key ?? credential?.apiKey;
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(OWN_PROVIDERS[providerId]?.signInHint ?? `No credential for ${providerId}.`), { code: "no-credential" });
  }
  return { token: value.trim(), type: credential?.type ?? "unknown" };
}

/**
 * Whether an own adapter can generate images for this user right now: it has a
 * credential by the runtime's rules and the account lists at least one image
 * model. The Tools page offers only providers that can; the others carry why
 * not as a code the desktop words in its language, and the original text.
 */
export async function availability(provider) {
  const unavailable = error => ({ available: false, code: typeof error?.code === "string" ? error.code : "other", reason: String(error?.message ?? error) });
  let value;
  try {
    value = (await token(provider.id)).token;
  } catch (error) {
    return unavailable(error);
  }
  try {
    const models = await provider.listModels(value);
    if (!models.length) return { available: false, code: "no-models", reason: "This account has no image models." };
    return { available: true, models: models.map(id => ({ id, sizes: provider.sizes?.(id) ?? SIZES })) };
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * The provider the tool uses: explicit argument, then settings, then the default.
 * A provider the runtime lists image models for is the runtime's; otherwise one
 * of the own adapters.
 */
export function chooseProvider(registry, configured, requested) {
  const id = requested || configured || DEFAULT_PROVIDER;
  if (registry && hasRuntimeProvider(registry, id)) return { id, runtime: true };
  const provider = OWN_PROVIDERS[id];
  if (!provider) throw new Error(`Unknown image provider: ${id}`);
  return { id, runtime: false, provider };
}

/** The models of a provider, each with the sizes it accepts (none for runtime models). */
export async function listModels(registry, id) {
  const chosen = chooseProvider(registry, id);
  if (chosen.runtime) return listRuntimeModels(registry, chosen.id);
  const { token: value } = await token(chosen.id);
  const models = await chosen.provider.listModels(value);
  return models.map(model => ({ id: model, sizes: chosen.provider.sizes?.(model) ?? SIZES }));
}

/** A model is always chosen when the provider lists one; only an empty list fails. */
export async function chooseModel(provider, configured, tokenValue) {
  if (configured) return configured;
  const models = await provider.listModels(tokenValue);
  if (!models.length) throw new Error("The provider lists no image models.");
  return models[0];
}

export function reviewBody({ toolName, input, image, sized = true }) {
  const count = Math.min(maxImages(image.maxImages), Math.max(1, Math.trunc(Number(input?.count ?? 1)) || 1));
  // The desktop renders these fields; a client without the review card still
  // sees readable JSON.
  return {
    count,
    text: JSON.stringify({
      tool: toolName,
      images: count,
      prompt: input?.prompt ?? "",
      provider: input?.provider || image.provider,
      model: input?.model || image.model || "",
      // Runtime image models take no size setting; naming one would mislead.
      ...(sized ? { size: input?.size || image.size } : {}),
    }),
  };
}

async function saveImages({ images, prompt, provider, model, sessionId, toolCallId }) {
  const saved = [];
  for (const result of images) {
    const bytes = Buffer.from(result.data, "base64");
    const artifact = await saveArtifact({
      home: home(),
      kind: "images",
      mimeType: result.mime,
      bytes,
      prompt,
      source: { tool: "generate_image", provider, model, sessionId, toolCallId },
    });
    saved.push({
      id: artifact.id,
      data: result.data,
      mimeType: artifact.mimeType,
      path: join(home(), "artifacts", artifact.path),
      bytes: artifact.bytes,
      width: artifact.dimensions?.width ?? null,
      height: artifact.dimensions?.height ?? null,
    });
  }
  return saved;
}

export async function generate({ provider: requested, model, size, prompt, count, sessionId, toolCallId, registry, signal }) {
  const current = await settings();
  if (!current.image.enabled) throw new Error("Image generation is disabled in Settings → Tools.");
  const total = Math.min(maxImages(current.image.maxImages), Math.max(1, Math.trunc(Number(count ?? 1)) || 1));
  // The settings' model belongs to the settings' provider; a different provider starts from its own first model.
  const providerChanged = requested && requested !== current.image.provider;
  const wantedModel = model || (providerChanged ? "" : current.image.model);
  const runtimeRegistry = registry ?? await registryLoader();
  const chosen = chooseProvider(runtimeRegistry, current.image.provider, requested);

  if (chosen.runtime) {
    const images = [];
    let chosenModel = wantedModel;
    while (images.length < total) {
      const result = await generateWithRuntime(runtimeRegistry, { provider: chosen.id, model: wantedModel, prompt, signal });
      chosenModel = result.model;
      images.push(...result.images.slice(0, total - images.length));
    }
    const saved = await saveImages({ images, prompt, provider: chosen.id, model: chosenModel, sessionId, toolCallId });
    return { provider: chosen.id, model: chosenModel, size: null, images: saved };
  }

  const provider = chosen.provider;
  const { token: value } = await token(provider.id);
  const chosenModel = await chooseModel(provider, wantedModel, value);
  // A size the model does not accept is a 400 from the provider; keep the
  // configured size when it is valid and otherwise take the model's first size.
  const allowed = provider.sizes?.(chosenModel) ?? SIZES;
  const wanted = SIZES.includes(size) ? size : current.image.size;
  const chosenSize = allowed.includes(wanted) ? wanted : allowed.includes(current.image.size) ? current.image.size : allowed[0] ?? "1K";
  const images = [];
  for (let index = 0; index < total; index += 1) {
    images.push(await provider.generate(value, { model: chosenModel, size: chosenSize, prompt }));
  }
  const saved = await saveImages({ images, prompt, provider: provider.id, model: chosenModel, sessionId, toolCallId });
  return { provider: provider.id, model: chosenModel, size: chosenSize, images: saved };
}

export default function jouzuImage(pi) {
  const approved = new Set();
  let sessionId = "";

  pi.on("session_start", (_event, ctx) => {
    approved.clear();
    try { sessionId = ctx?.sessionManager?.getSessionId?.() ?? ""; } catch { sessionId = ""; }
  });

  pi.on("tool_call", async (event, ctx) => {
    const current = await settings();
    if (!current.reviewTools.includes(event.toolName) || approved.has(event.toolName)) return undefined;
    let sized = true;
    try {
      sized = !hasRuntimeProvider(await registryFor(ctx), event.input?.provider || current.image.provider);
    } catch {
      sized = true;
    }
    const { text } = reviewBody({ toolName: event.toolName, input: event.input, image: current.image, sized });
    const choice = await ctx.ui.select(`Review tool call\n${text}`, ["Approve", "Approve for this session", "Deny"], { timeout: 120_000 });
    if (choice === "Approve") return undefined;
    if (choice === "Approve for this session") { approved.add(event.toolName); return undefined; }
    return { block: true, reason: choice === "Deny" ? "The user declined this tool call." : "No response; the tool call was declined." };
  });

  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate one to a few images from a text prompt with the configured image provider. " +
      "The provider, model and size come from Settings → Tools unless passed here.",
    promptSnippet: "Generate images from a prompt with the configured image provider",
    promptGuidelines: [
      "Use this when the user asks for an image.",
      "The user reviews this call before it runs; do not ask for approval in the message.",
      "Each image is stored as an artifact and its path is returned.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw." },
        count: { type: "integer", minimum: 1, description: "How many images; defaults to 1, capped by Settings → Tools." },
        provider: { type: "string", description: "Optional image provider id; defaults to Settings → Tools." },
        model: { type: "string", description: "Optional model; defaults to Settings → Tools or the provider's first model." },
        size: { type: "string", enum: SIZES, description: "Optional size, for providers that take one." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const prompt = String(params.prompt ?? "").trim();
      const result = await generate({
        provider: params.provider,
        model: params.model,
        size: params.size,
        count: params.count,
        prompt,
        sessionId,
        toolCallId,
        registry: ctx?.modelRegistry,
        signal,
      });
      const lines = result.images.map((image, index) => `${index + 1}. ${image.path}`).join("\n");
      return {
        content: [
          { type: "text", text: `Generated ${result.images.length} image${result.images.length === 1 ? "" : "s"}.\nPrompt: "${prompt}"\nProvider: ${result.provider} · Model: ${result.model}${result.size ? ` · Size: ${result.size}` : ""}\n${lines}` },
          ...result.images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType })),
        ],
        details: {
          prompt,
          provider: result.provider,
          model: result.model,
          size: result.size,
          images: result.images.map(({ data: _data, ...image }) => image),
          usage: null,
        },
      };
    },
  });
}

// CLI entry for the desktop's Tools page: node index.js --providers | --models <id>
// --providers reports each provider with whether it is usable, and why not.
const invoked = typeof process.argv[1] === "string" && /index\.(m?js)$/.test(process.argv[1]);
if (invoked && process.argv[2]?.startsWith("--")) {
  const command = process.argv[2];
  try {
    if (command === "--providers") {
      const list = await listProviders(await registryLoader());
      process.stdout.write(`${JSON.stringify({ providers: list })}\n`);
    } else if (command === "--models") {
      const models = await listModels(await registryLoader(), process.argv[3] || DEFAULT_PROVIDER);
      process.stdout.write(`${JSON.stringify({ models })}\n`);
    } else {
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
    process.exitCode = 1;
  }
}
