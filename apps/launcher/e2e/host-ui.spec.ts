import { test, expect } from "@playwright/test";

/**
 * Runs the real UI against a real host, with the endpoint the desktop shell would
 * inject. Native-only surfaces (tray, updater, terminal) stay hidden because the
 * page reports no native capability.
 */
const baseUrl = process.env.JOUZU_HOST_URL;
const token = process.env.JOUZU_HOST_TOKEN;

test.skip(!baseUrl || !token, "set JOUZU_HOST_URL and JOUZU_HOST_TOKEN to run");

test("the page boots from the injected host endpoint", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));

  await page.addInitScript(
    ([url, value]) => {
      (window as unknown as { __JOUZU_HOST__?: { baseUrl: string; token: string } }).__JOUZU_HOST__ = {
        baseUrl: url,
        token: value,
      };
    },
    [baseUrl!, token!],
  );

  await page.goto(`${baseUrl}/`);
  await expect(page.getByRole("heading", { name: "Jouzu", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Workspaces" })).toBeVisible();
  await expect(page.getByText("Connecting to Jouzu…")).toHaveCount(0);

  // The workspace list comes from the host, not from a shell bridge.
  await expect(page.getByRole("button", { name: /add folder/i })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Environment", exact: true })).toBeVisible();

  expect(errors.filter(message => !/tauri|invoke|__TAURI/iu.test(message))).toEqual([]);
});

test("a chat session opens through the host", async ({ page }) => {
  test.skip(!baseUrl || !token, "set JOUZU_HOST_URL and JOUZU_HOST_TOKEN to run");
  page.on("pageerror", error => console.log(`[pageerror] ${String(error)}`));
  await page.addInitScript(
    ([url, value]) => {
      (window as unknown as { __JOUZU_HOST__?: { baseUrl: string; token: string } }).__JOUZU_HOST__ = {
        baseUrl: url,
        token: value,
      };
    },
    [baseUrl!, token!],
  );

  await page.goto(`${baseUrl}/`);
  const history = page.waitForResponse(response => response.url().includes("/v1/sessions/messages"), { timeout: 30_000 });
  await page.getByRole("button", { name: /can you read this/i }).first().click();
  await history;

  // The composer proves the session attached: a dead session shows "Connecting…"
  // forever instead of the model picker.
  // The transcript came from the host, and the composer is ready for a turn.
  await expect(page.getByPlaceholder(/Message Jouzu/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/can you read this/i).first()).toBeVisible();
});





