import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Appearance screenshots against the built app and a scripted host.
 *
 *   cd apps/desktop && npm run build
 *   JOUZU_SHOTS=1 npx playwright test e2e/appearance-shots.spec.ts
 *
 * Files land in docs/design/screenshots/. `SHOT_PREFIX=before-` writes a set
 * under that prefix. Not part of the normal suite.
 */
test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

const enabled = !!process.env.JOUZU_SHOTS;
const prefix = process.env.SHOT_PREFIX ?? "";
const out = resolve("../../docs/design/screenshots");
let host: ChildProcess | undefined;
let base = "";

/** A theme is a family; the mode is what the person chooses inside it. */
const captures = [
  { name: "dark", theme: "jouzu", mode: "dark" },
  { name: "light", theme: "jouzu", mode: "light" },
  { name: "nocturne", theme: "editorial", mode: "dark" },
  { name: "folio", theme: "editorial", mode: "light" },
] as const;

test.describe.configure({ mode: "serial" });
test.skip(!enabled, "set JOUZU_SHOTS=1 to regenerate appearance screenshots");

test.beforeAll(async () => {
  await mkdir(out, { recursive: true });
  host = spawn(process.execPath, ["e2e/appearance-host.mjs", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  base = await new Promise<string>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("appearance host did not start")), 10_000);
    host!.stdout?.on("data", chunk => {
      const match = /theme host on (http:\/\/\S+)/u.exec(String(chunk));
      if (match) { clearTimeout(timer); ready(match[1]); }
    });
    host!.on("exit", code => fail(new Error(`appearance host exited (${code})`)));
  });
});

test.afterAll(() => {
  host?.kill();
});

function tauriMock(options: { theme: string; mode: string; onboarding: boolean }) {
  localStorage.setItem("jouzu.ui.language", "en");
  if (!localStorage.getItem("jouzu.ui.theme")) {
    localStorage.setItem("jouzu.ui.theme", options.theme);
    localStorage.setItem("jouzu.ui.mode", options.mode);
  }
  const w = window as any;
  w.isTauri = true;
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `shot-${Math.random().toString(16).slice(2)}` });
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 1, unregisterCallback() {},
    invoke: async (command: string) => {
      if (command === "runtime_report") {
        if (!options.onboarding) return { version: "0.3.8", node: true, nodeCurrent: true };
        await new Promise(resolve => setTimeout(resolve, 1200));
        return { version: "0.3.8", node: false, nodeCurrent: false };
      }
      if (command === "runtime_install") return "installing";
      if (command === "component_versions") return options.onboarding ? { jouzu: null, development: false } : { jouzu: "0.3.8", development: false };
      if (command === "shell_state") return { ready: true, bash: true, bundled_git: true, platform: "windows", recent: [{ id: "work", path: "C:/Projects/Example", environment: { kind: "windows" } }] };
      if (command === "environment_read") return [];
      if (command.includes("version")) return "0.3.8";
      return 1;
    },
  };
}

async function shot(page: import("@playwright/test").Page, name: string) {
  await page.screenshot({ path: resolve(out, `${prefix}${name}.png`) });
}

async function open(page: import("@playwright/test").Page, options: { theme: string; mode: string; onboarding?: boolean }) {
  await page.addInitScript(tauriMock, { onboarding: false, ...options });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await expect(page.getByText("one accent", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  // The scripted host never finishes the entry handshake; the chat behind the loader is complete.
  await page.addStyleTag({ content: "main.fixed.inset-0 { display: none !important; }" });
}

async function openFirstRun(page: import("@playwright/test").Page, options: { theme: string; mode: string }) {
  await page.addInitScript(tauriMock, { theme: options.theme, mode: options.mode, onboarding: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await page.waitForTimeout(2800);
}

for (const capture of captures) {
  test(`${capture.name}: chat, appearance, hero`, async ({ page }) => {
    await open(page, { theme: capture.theme, mode: capture.mode });
    await page.getByLabel("Message Jouzu").click();
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(900);
    await shot(page, `${capture.name}-chat`);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.waitForTimeout(400);
    await shot(page, `${capture.name}-settings`);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.waitForTimeout(600);
    await shot(page, `${capture.name}-hero`);
  });

  test(`${capture.name}: first run`, async ({ page }) => {
    await openFirstRun(page, { theme: capture.theme, mode: capture.mode });
    await shot(page, `${capture.name}-onboarding`);
  });
}

test("the theme family and its mode are two levels", async ({ page }) => {
  await open(page, { theme: "jouzu", mode: "system" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();

  const themeSelect = page.getByRole("combobox", { name: "Theme" });
  const modeSelect = page.getByRole("combobox", { name: "Mode" });
  await expect(themeSelect).toBeVisible();
  await expect(modeSelect).toBeVisible();
  await themeSelect.click();
  const themes = await page.getByRole("option").allInnerTexts();
  expect(themes).toEqual(["Jouzu", "Editorial"]);
  await shot(page, "appearance-themes");
  await page.keyboard.press("Escape");

  await modeSelect.click();
  const modes = await page.getByRole("option").allInnerTexts();
  expect(modes).toEqual(["System", "Dark", "Light"]);
  await shot(page, "appearance-modes");
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  const html = page.locator("html");
  await themeSelect.click();
  await page.getByRole("option", { name: "Editorial", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "editorial");
  await expect(html).toHaveAttribute("data-mode", "dark");
  await expect(modeSelect).toBeVisible();

  await modeSelect.click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await expect(html).toHaveAttribute("data-mode", "light");
  await expect(html).toHaveClass(/light/);

  await themeSelect.click();
  await page.getByRole("option", { name: "Jouzu", exact: true }).click();
  expect(await html.getAttribute("data-theme")).toBeNull();
  await expect(html).toHaveClass(/light/);

  await modeSelect.click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(html).not.toHaveClass(/light/);
});

for (const check of [
  { name: "editorial-system-dark", scheme: "dark", mode: "dark", background: "rgb(20, 17, 13)" },
  { name: "editorial-system-light", scheme: "light", mode: "light", background: "rgb(243, 237, 226)" },
] as const) {
  test(`${check.name}: System follows the OS`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: check.scheme });
    await open(page, { theme: "editorial", mode: "system" });
    await expect(page.locator("html")).toHaveAttribute("data-mode", check.mode);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(check.background);
    await page.waitForTimeout(600);
    await shot(page, check.name);
  });
}

test("a single-variant theme has no System and no mode control", async ({ page }) => {
  const pkg = readFileSync(resolve("../../docs/design/theme-package.example.json"), "utf8");
  await open(page, { theme: "jouzu", mode: "dark" });
  await page.evaluate((raw: string) => {
    const theme = JSON.parse(raw);
    localStorage.setItem("jouzu.ui.themes", JSON.stringify([theme]));
    localStorage.setItem("jouzu.ui.theme", theme.id);
    localStorage.setItem("jouzu.ui.mode", "dark");
  }, pkg);

  await page.reload();
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "moss", { timeout: 20_000 });
  await expect(html).toHaveAttribute("data-mode", "dark");
  await page.addStyleTag({ content: "main.fixed.inset-0 { display: none !important; }" });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(16, 23, 18)");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Theme" })).toContainText("Moss");
  await expect(page.getByRole("combobox", { name: "Mode" })).toHaveCount(0);
  await shot(page, "appearance-single-mode");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await shot(page, "runtime-theme");

  await page.evaluate(() => {
    localStorage.removeItem("jouzu.ui.themes");
    localStorage.removeItem("jouzu.ui.theme");
    localStorage.removeItem("jouzu.ui.mode");
  });
  await page.reload();
  await page.addStyleTag({ content: "main.fixed.inset-0 { display: none !important; }" });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBeNull();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(18, 19, 24)");
});