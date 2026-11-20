import { test, expect, type Page } from "@playwright/test";
import { UI_BASE, stubHost, emptyControlState } from "./host-control";

type Provider = { id: string; label: string; available: boolean; code?: string; reason?: string; models?: { id: string; sizes: string[] }[] };

const saved = { enabled: true, provider: "shisa", model: "gemini-3-pro-image", size: "1K", maxImages: 3 };
const off = { ...saved, enabled: false };
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
async function openTools(page: Page, image: Record<string, unknown>, providers: Provider[], options: { notInstalled?: boolean } = {}) {
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
    if (url.pathname === "/v1/tools/providers") {
      if (options.notInstalled) return json({ error: { code: "tools-unavailable", message: "The image tool is not installed yet", retryable: true } }, 503);
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
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Tools" }).click();
  await expect(dialog.getByText("Image generation", { exact: true })).toBeVisible();
  return { dialog, saves, models, errors };
}

const imageSwitch = (page: Page) => page.getByRole("dialog").getByRole("switch", { name: "Enable image generation" });

test("the Tools tab edits the image tool settings", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, saved, [usableShisa]);
  // One provider that can work is named as text, not offered as an empty choice.
  await expect(dialog.getByText("Shisa.AI", { exact: true })).toBeVisible();
  await expect(imageSwitch(page)).toBeChecked();
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3-pro-image");
  await expect(dialog.getByLabel("Images per call", { exact: true })).toHaveValue("3");
  await expect(dialog.getByText("Reviewed calls: generate_image")).toBeVisible();
  await dialog.getByLabel("Image model", { exact: true }).selectOption("gemini-3.1-flash-image");
  await expect.poll(() => saves.at(-1)?.model ?? null).toBe("gemini-3.1-flash-image");
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3.1-flash-image");
  expect(errors).toEqual([]);
});

// #64, #180 and ui-layer §6.1: no usable provider replaces the levels with one line and one action.
test("with no usable provider the card says what to connect and keeps the reasons under Details", async ({ page }) => {
  const { dialog, saves, models, errors } = await openTools(page, saved, [signedOutShisa]);
  await expect(imageSwitch(page)).not.toBeChecked();
  await expect(imageSwitch(page)).toBeDisabled();
  await expect(dialog.getByText("Connect Shisa.AI to generate images.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toBeVisible();
  // No level is drawn beside an empty parent.
  await expect(dialog.getByLabel("Image provider", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Image size", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Images per call", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("No image provider available")).toHaveCount(0);
  await expect(dialog.getByText("No models")).toHaveCount(0);
  // The reason is available, but not as a line of the page.
  const details = dialog.locator("details");
  const reason = details.getByText("Shisa.AI: Not signed in. Add a key or sign in.", { exact: false });
  await expect(reason).toBeHidden();
  await details.getByText("Details", { exact: true }).click();
  await expect(reason).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(models).toEqual([]);
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
});

test("with no usable provider the destination is named once", async ({ page }) => {
  const { dialog } = await openTools(page, saved, [signedOutShisa, noCredentialOpenRouter]);
  const line = dialog.getByText("Connect Shisa.AI or OpenRouter to generate images.", { exact: true });
  await expect(line).toBeVisible();
  expect((await line.innerText()).match(/Model providers/g) ?? []).toHaveLength(0);
  await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(1);
});

// ui-layer §6.1: the levels exist only while the switch can be on.
test("a saved switch that is off hides every level until the person turns it on", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, off, [usableShisa]);
  await expect(imageSwitch(page)).not.toBeChecked();
  await expect(imageSwitch(page)).toBeEnabled();
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Images per call", { exact: true })).toHaveCount(0);
  await imageSwitch(page).click();
  await expect(imageSwitch(page)).toBeChecked();
  await expect.poll(() => saves.at(-1) ?? null).toMatchObject({ enabled: true, provider: "shisa", model: "gemini-3-pro-image" });
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3-pro-image");
  expect(errors).toEqual([]);
});

// #67: with no tools.json the page renders, and the first usable provider is chosen and saved.
test("the Tools tab opens with no saved tools settings", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, fresh, [usableShisa]);
  await expect(imageSwitch(page)).toBeChecked();
  await expect.poll(() => saves.at(-1) ?? null).toMatchObject({ provider: "shisa", model: "gemini-3-pro-image", size: "1K" });
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveValue("gemini-3-pro-image");
  expect(errors).toEqual([]);
});

test("the Tools tab opens with no saved settings and no usable provider", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, fresh, [signedOutShisa]);
  await expect(imageSwitch(page)).not.toBeChecked();
  await expect(imageSwitch(page)).toBeDisabled();
  await expect(dialog.getByText("Connect Shisa.AI to generate images.", { exact: true })).toBeVisible();
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
});

test("the image tool not installed shows the switch and one line, nothing below", async ({ page }) => {
  const { dialog, saves, errors } = await openTools(page, saved, [], { notInstalled: true });
  await expect(imageSwitch(page)).not.toBeChecked();
  await expect(imageSwitch(page)).toBeDisabled();
  await expect(dialog.getByText("The image tool is not installed yet.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Image model", { exact: true })).toHaveCount(0);
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

test("a runtime provider without a credential is not offered while another works", async ({ page }) => {
  const { dialog, errors } = await openTools(page, saved, [usableShisa, noCredentialOpenRouter]);
  const provider = dialog.getByLabel("Image provider", { exact: true });
  await expect(provider).toHaveCount(0);
  await expect(dialog.getByText("Shisa.AI", { exact: true })).toBeVisible();
  // A provider that cannot make images is not offered, and not explained beside one that works.
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByText("OpenRouter", { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});