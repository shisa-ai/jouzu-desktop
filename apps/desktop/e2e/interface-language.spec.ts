import { test, expect } from "@playwright/test";
import { UI_BASE, stubHost, emptyControlState } from "./host-control";

// #100: with the interface set to Japanese, the Tools page is Japanese too.

test("the Tools page follows the interface language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("jouzu.ui.language", "ja"));
  await stubHost(page, { control: () => emptyControlState });
  const image = { enabled: true, provider: "shisa", model: "gemini-3-pro-image", size: "1K", maxImages: 3 };
  await page.route("**/v1/tools**", async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/v1/tools") return json({ path: "tools.json", exists: true, settings: { image, reviewTools: ["generate_image"] } });
    if (url.pathname === "/v1/tools/providers") return json({ providers: [{ id: "shisa", label: "Shisa.AI", available: true, models: [{ id: "gemini-3-pro-image", sizes: ["1K"] }] }] });
    if (url.pathname === "/v1/tools/models") return json({ models: [{ id: "gemini-3-pro-image", sizes: ["1K"] }] });
    return route.fallback();
  });
  await page.goto(UI_BASE);
  await page.getByRole("button", { name: "設定", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "ツール", exact: true }).click();
  const panel = dialog.getByRole("tabpanel");
  await expect(panel.getByText("画像生成", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("画像プロバイダー", { exact: true })).toHaveValue("shisa");
  await expect(panel.getByText("確認が必要な呼び出し：generate_image")).toBeVisible();
  // Nothing in the panel is English of its own (names and values are not translated).
  const words = (await panel.innerText()).replace(/generate_image|Shisa\.AI|gemini-3-pro-image|\b1K\b/gu, "");
  expect(words).not.toMatch(/[A-Za-z]{3,}/u);
});
