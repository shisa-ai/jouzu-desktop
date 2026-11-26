import { test, expect, type Page } from "@playwright/test";
import { UI_BASE, stubHost, emptyControlState } from "./host-control";

type Provider = { id: string; label: string; available: boolean; code?: string; reason?: string; models?: { id: string; sizes: string[] }[] };

const saved = { enabled: true, provider: "shisa", model: "gemini-3-pro-image", size: "1K", maxImages: 3 };
// What the host answers with no tools.json (#67): a full image section, no provider chosen.
const fresh = { enabled: true, provider: "", model: "", size: "1K", maxImages: 3 };
const usableShisa: Provider = {
  id: "shisa", label: "Shisa.AI", available: true,
  models: [{ id: "gemini-3-pro-image", sizes: ["1K", "2K", "4K"] }, { id: "gemini-3.1-flash-image", sizes: ["1K", "2K", "4K"] }],
};
// A provider from the runtime's model catalog (#65): its image API takes no size.
const usableOpenRouter: Provider = {
  id: "openrouter", label: "OpenRouter", available: true,
  models: [{ id: "black-forest-labs/flux.2-pro", sizes: [] }, { id: "google/gemini-2.5-flash-image", sizes: [] }],
};
const noCredentialOpenRouter: Provider = { id: "openrouter", label: "OpenRouter", available: false, code: "no-credential", reason: "No credential for OpenRouter. Add one under Model providers to generate images with it." };
const signedOutShisa: Provider = { id: "shisa", label: "Shisa.AI", available: false, code: "no-credential", reason: "Sign in to Shisa.AI or set SHISA_API_KEY to generate images." };

/** Opens Settings → Tools against a host whose image tool reports `providers`. Returns what the page saved. */
async function openTools(page: Page, image: Record<string, unknown>, providers: Provider[], options: { locale?: string; providersReady?: Promise<void>; providersError?: string } = {}) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const saves: Record<string, unknown>[] = [];
  const models: string[] = [];
  let settings = { image, reviewTools: ["generate_image"] };
  const locale = options.locale ?? "en";
  await page.addInitScript(locale => localStorage.setItem("jouzu.ui.language", locale), locale);
  await stubHost(page, { control: () => emptyControlState });
  await page.route("**/v1/tools**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/v1/tools" && request.method() === "PUT") {
      const next = request.postDataJSON().image;
      saves.push(next);
      settings = { ...settings, image: next };
      return json(settings);
    }
    if (url.pathname === "/v1/tools") return json({ path: "tools.json", exists: image !== fresh, settings });
    if (url.pathname === "/v1/tools/providers") {
      await options.providersReady;
      if (options.providersError) return json({ error: { code: options.providersError, message: "Image tool unavailable", retryable: false } }, 503);
      return json({ providers });
    }
    if (url.pathname === "/v1/tools/models") {
      const id = url.searchParams.get("provider") ?? "";
      models.push(id);
      const provider = providers.find(entry => entry.id === id);
      if (!provider?.available) return json({ error: { code: "tools-error", message: provider?.reason ?? "Unknown image provider", retryable: true } }, 502);
      return json({ models: provider.models });
    }
    return route.fallback();
  });
  await page.goto(UI_BASE);
  await page.getByRole("button", { name: locale === "en" ? "Settings" : locale === "zh-Hans" ? "设置" : "設定", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: locale === "en" ? "Tools" : locale === "ja" ? "ツール" : "工具", exact: true }).click();
  await expect(dialog.getByText(locale === "en" ? "Image generation" : locale === "ja" ? "画像生成" : locale === "zh-Hans" ? "图片生成" : "圖片生成", { exact: true })).toBeVisible();
  return { dialog, saves, models, errors };
}

// #180: one setup state replaces redundant disabled controls and per-provider advice.
test("all signed-out image providers show one setup action without changing saved settings", async ({ page }) => {
  const { dialog, saves, models, errors } = await openTools(page, saved, [signedOutShisa, noCredentialOpenRouter]);
  await expect(dialog.getByRole("status")).toHaveText("Image generation is not configured.");
  await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Image size", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("list", { name: "Unavailable image providers" })).toHaveCount(0);
  await expect(dialog.getByRole("switch", { name: "Enable image generation" })).toBeChecked();
  await expect(dialog.getByLabel("Images per call", { exact: true })).toHaveValue("3");
  await dialog.getByRole("button", { name: "Model providers", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "Model providers", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel", { name: "Model providers", exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Image generation is not configured.");
  expect(saves).toEqual([]);
  expect(models).toEqual([]);
  expect(errors).toEqual([]);
});

test("the Tools tab edits the image tool settings", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, saved, [usableShisa]);
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveValue("shisa");
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3-pro-image");
  await expect(dialog.getByLabel("Images per call", { exact: true })).toHaveValue("3");
  await expect(dialog.getByText("Reviewed calls: generate_image")).toBeVisible();
  await dialog.getByLabel("Image model", { exact: true }).selectOption("gemini-3.1-flash-image");
  await expect.poll(() => saves.at(-1)?.model ?? null).toBe("gemini-3.1-flash-image");
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3.1-flash-image");
  expect(errors).toEqual([]);
});

// #64: a provider that cannot generate images is not offered, and its reason is shown as a state, not an error.
test("an unusable image provider is not offered, and says why", async ({ page }) => {
  const { dialog, saves, models, errors } = await openTools(page, saved, [{ ...signedOutShisa, code: "not-allowed" }]);
  const provider = dialog.getByLabel("Image provider", { exact: true });
  await expect(provider).toBeDisabled();
  await expect(provider.locator("option")).toHaveText(["No image provider available"]);
  await expect(dialog.getByLabel("Image model", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Image size", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("list", { name: "Unavailable image providers" })).toHaveText("Shisa.AI: This account cannot generate images.");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText("This tools change did not complete.")).toHaveCount(0);
  expect(models).toEqual([]);
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
});

// #67: with no tools.json the page renders, and the first usable provider is chosen and saved.
test("the Tools tab opens with no saved tools settings", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, fresh, [usableShisa]);
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveValue("shisa");
  await expect.poll(() => saves.at(-1) ?? null).toMatchObject({ provider: "shisa", model: "gemini-3-pro-image", size: "1K" });
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3-pro-image");
  expect(errors).toEqual([]);
});

test("the Tools tab opens with no saved settings and no usable provider", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, fresh, [signedOutShisa]);
  await expect(dialog.getByRole("status")).toHaveText("Image generation is not configured.");
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveCount(0);
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
});

// #65: the runtime's image providers are offered beside Shisa, and switching keeps settings coherent.
test("the image provider list includes the runtime's providers and switching keeps settings coherent", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, saved, [usableShisa, usableOpenRouter]);
  const provider = dialog.getByLabel("Image provider", { exact: true });
  await expect(provider).toHaveValue("shisa");
  await expect(dialog.getByLabel("Image size", { exact: true })).toBeVisible();
  await expect(provider.locator("option")).toHaveText(["Shisa.AI", "OpenRouter"]);

  // Another provider: its first model is chosen and saved, and no size is offered (the runtime takes none).
  await provider.selectOption("openrouter");
  await expect.poll(() => saves.at(-1)?.provider ?? null).toBe("openrouter");
  expect(saves.at(-1)?.model).toBe("black-forest-labs/flux.2-pro");
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("black-forest-labs/flux.2-pro");
  await expect(dialog.getByLabel("Image size", { exact: true })).toHaveCount(0);

  // Back to Shisa: its model list and size control return.
  await provider.selectOption("shisa");
  await expect.poll(() => saves.at(-1)?.provider ?? null).toBe("shisa");
  expect(saves.at(-1)?.model).toBe("gemini-3-pro-image");
  await expect(dialog.getByLabel("Image size", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a runtime provider without a credential is not offered, and says why", async ({ page }) => {
  const { dialog, saves, models, errors } = await openTools(page, saved, [usableShisa, noCredentialOpenRouter]);
  await expect(dialog.getByLabel("Image provider", { exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
  expect(saves).toEqual([]);
  expect(models).toEqual([]);
  await expect(dialog.getByLabel("Image provider", { exact: true }).locator("option")).toHaveText(["Shisa.AI"]);
  await expect(dialog.getByRole("list", { name: "Unavailable image providers" })).toHaveText("OpenRouter: Not signed in. Add a key or sign in under Model providers.");
  expect(errors).toEqual([]);
});

for (const code of ["no-credit", "sign-in-refused", "unreachable", "unknown-code", ""]) {
  test("missing credentials mixed with " + (code || "no code") + " keep distinct provider states", async ({ page }) => {
    const { dialog, saves, models } = await openTools(page, saved, [signedOutShisa, { ...noCredentialOpenRouter, code }]);
    const list = dialog.getByRole("list", { name: "Unavailable image providers" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list).toContainText("Shisa.AI: Not signed in.");
    await expect(list).toContainText(code === "no-credit" ? "out of credit" : code === "sign-in-refused" ? "The sign-in was refused." : code === "unreachable" ? "Could not be reached." : "Not available.");
    await expect(dialog.getByLabel("Image provider", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
    expect(saves).toEqual([]);
    expect(models).toEqual([]);
  });
}

for (const locale of ["ja", "zh-Hans", "zh-Hant"]) {
  test("image setup and navigation are localized in " + locale, async ({ page }) => {
    const { dialog, saves, models } = await openTools(page, { ...saved, enabled: false }, [signedOutShisa], { locale });
    const label = locale === "ja" ? "モデルプロバイダー" : locale === "zh-Hans" ? "模型提供商" : "模型供應商";
    await expect(dialog.getByRole("status")).toHaveText(locale === "ja" ? "画像生成は未設定です。" : locale === "zh-Hans" ? "图片生成尚未配置。" : "圖片生成尚未設定。");
    await expect(dialog.getByRole("switch")).not.toBeChecked();
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await expect(dialog.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    expect(saves).toEqual([]);
    expect(models).toEqual([]);
  });
}

for (const providersError of [undefined, "tools-unavailable"]) {
  test(providersError ? "an absent image tool is not a credential setup state" : "an empty image provider list is not a credential setup state", async ({ page }) => {
    const { dialog, saves, models } = await openTools(page, saved, [], { providersError });
    await expect(dialog.getByLabel("Image provider", { exact: true }).locator("option")).toHaveText(["No image provider available"]);
    await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
    if (providersError) await expect(dialog.locator("[data-tools-not-installed]")).toBeVisible();
    else await expect(dialog.getByRole("status")).toHaveCount(0);
    expect(saves).toEqual([]);
    expect(models).toEqual([]);
  });
}

test("loading image providers does not prematurely offer credential setup", async ({ page }) => {
  let ready!: () => void;
  const providersReady = new Promise<void>(resolve => { ready = resolve; });
  const { dialog, saves, models } = await openTools(page, saved, [signedOutShisa], { providersReady });
  await expect(dialog.getByLabel("Image provider", { exact: true }).locator("option")).toHaveText(["Loading…"]);
  await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
  ready();
  await expect(dialog.getByRole("status")).toHaveText("Image generation is not configured.");
  expect(saves).toEqual([]);
  expect(models).toEqual([]);
});
