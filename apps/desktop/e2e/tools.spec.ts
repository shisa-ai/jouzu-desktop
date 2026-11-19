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
async function openTools(page: Page, image: Record<string, unknown>, providers: Provider[]) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const saves: Record<string, unknown>[] = [];
  const models: string[] = [];
  let settings = { image, reviewTools: ["generate_image"] };
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "en"));
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
    if (url.pathname === "/v1/tools/providers") return json({ providers });
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
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Tools" }).click();
  await expect(dialog.getByText("Image generation", { exact: true })).toBeVisible();
  return { dialog, saves, models, errors };
}

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
  const { dialog, saves, models, errors } = await openTools(page, saved, [signedOutShisa]);
  const provider = dialog.getByLabel("Image provider", { exact: true });
  await expect(provider).toBeDisabled();
  await expect(provider.locator("option")).toHaveText(["No image provider available"]);
  await expect(dialog.getByLabel("Image model", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Image size", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("list", { name: "Unavailable image providers" })).toHaveText("Shisa.AI: Not signed in. Add a key or sign in under Model providers.");
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
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("list", { name: "Unavailable image providers" })).toBeVisible();
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
  const { dialog, errors } = await openTools(page, saved, [usableShisa, noCredentialOpenRouter]);
  await expect(dialog.getByLabel("Image provider", { exact: true }).locator("option")).toHaveText(["Shisa.AI"]);
  await expect(dialog.getByRole("list", { name: "Unavailable image providers" })).toHaveText("OpenRouter: Not signed in. Add a key or sign in under Model providers.");
  expect(errors).toEqual([]);
});
