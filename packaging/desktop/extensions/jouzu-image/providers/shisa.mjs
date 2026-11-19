// Shisa.AI image provider. One implementation of the image provider interface;
// other providers are added beside this file.
const BASE = "https://api.shisa.ai/image";

// Size capability lives with the provider: the models endpoint does not publish it.
const SIZES = { "gemini-3.1-flash-lite-image": ["1K"], "gemini-3.1-flash-image": ["1K", "2K", "4K"], "gemini-3-pro-image": ["1K", "2K", "4K"] };
const ALL_SIZES = ["1K", "2K", "4K"];

/** An error with the code the desktop words in its own language; the text stays for Details. */
function coded(code, text) {
  return Object.assign(new Error(text), { code });
}

async function failure(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = body?.error?.code ?? body?.code;
  // The router names its errors; the name decides over the status.
  if (code === "model_not_in_plan") return coded("not-allowed", "This account's plan does not include image generation.");
  if (code === "insufficient_balance" || code === "free_allowance_exhausted") return coded("no-credit", "This account is out of credit for image generation.");
  if (response.status === 401) return coded("sign-in-refused", "Sign in to Shisa.AI again to generate images.");
  if (response.status === 403 && (code === 311 || body?.code === 311)) return coded("not-allowed", "This account cannot use image generation (shisa/image).");
  if (response.status === 400) return coded("other", `The model or image size was rejected${body?.error?.message ? ` (${body.error.message})` : ""}.`);
  if (response.status === 413) return coded("other", "The prompt is too large.");
  if (response.status === 429 || response.status === 503) return coded("busy", "Image generation is busy. Try again in a moment.");
  return coded("other", `Image generation failed (HTTP ${response.status}).`);
}

export default {
  id: "shisa",
  label: "Shisa.AI",
  signInHint: "Sign in to Shisa.AI or set SHISA_API_KEY to generate images.",

  /**
   * Jouzu's own rule for the Shisa credential, as its voice input and catalog
   * use it: a local sign-out suppresses every credential, then SHISA_API_KEY,
   * then an unexpired `/login shisa` sign-in. An expired sign-in is no credential.
   */
  async credential({ env, agentDir, runtimeModule }) {
    const { isShisaSignedOut, readShisaLoginToken } = await runtimeModule("jouzu/dist/shisa-link/credentials.js");
    const paths = { agentDir };
    if (isShisaSignedOut(paths)) return undefined;
    const key = env.SHISA_API_KEY?.trim();
    if (key) return { type: "api_key", key };
    const access = readShisaLoginToken(paths);
    return access ? { type: "oauth", access } : undefined;
  },

  /** The sizes this model accepts; unknown models keep the full set. */
  sizes(model) {
    return SIZES[model] ?? ALL_SIZES;
  },

  async listModels(token) {
    // Shorter than the desktop's 20 s wait for the Tools page answer.
    const response = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw coded("unreachable", "Shisa.AI could not be reached.");
    });
    if (!response.ok) throw await failure(response);
    const body = await response.json().catch(() => null);
    const list = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
    return list
      .map(item => item?.name ?? item?.id)
      .filter(value => typeof value === "string")
      .map(value => value.replace(/^models\//, "").trim())
      .filter(Boolean);
  },

  async generate(token, { model, size, prompt }) {
    const response = await fetch(`${BASE}/v1beta/interactions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: prompt, store: false, response_format: { type: "image", image_size: size } }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw await failure(response);
    const body = await response.json().catch(() => null);
    const image = (body?.steps ?? [])
      .flatMap(step => (Array.isArray(step?.content) ? step.content : []))
      .find(item => item?.type === "image");
    if (!image?.data) throw new Error("The answer contained no image.");
    return { data: image.data, mime: image.mime_type ?? "image/png" };
  },
};
