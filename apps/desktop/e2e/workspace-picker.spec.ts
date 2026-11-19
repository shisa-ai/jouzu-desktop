import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { emptyControlState, stubHost, type Workspace } from "./host-control";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

// The new-session workspace picker must stay inside the window: its list scrolls
// inside the menu and the page behind it does not move (#114).
test("a long workspace list scrolls inside the picker, not the page", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const workspaces: Workspace[] = Array.from({ length: 15 }, (_, index) => {
    const path = `C:/Projects/Workspace ${String(index).padStart(2, "0")}`;
    return { id: `windows:${path}`, path, environment: { kind: "windows" } };
  });
  // The UI reads the host over HTTP (/v1), so the host is answered at the network
  // boundary like in every other spec; no __TAURI_INTERNALS__ is involved.
  await stubHost(page, {
    control: () => ({ ...emptyControlState, modelReady: true }),
    workspaces,
  });
  await page.addInitScript(() => {
    localStorage.setItem("jouzu.ui.language", "en");
    if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `test-${Math.random().toString(16).slice(2)}` });
  });
  const dist = resolve("dist");
  await page.route("http://jouzu-ui.test/**", async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname.startsWith("/v1/")) return route.fallback();
    const file = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!file.startsWith(dist + sep)) return route.abort();
    const contentType = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream";
    try { await route.fulfill({ body: await readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.goto("http://jouzu-ui.test/");
  await expect(page.getByText("What would you like to build?")).toBeVisible();
  await page.getByRole("button", { name: "Choose workspace" }).click();
  const menu = page.getByRole("menu", { name: "Choose workspace" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button", { name: "Add folder" })).toBeVisible();

  const layout = await menu.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const list = element.querySelector("[data-workspace-list]");
    const container = element.closest(".overflow-y-auto") as HTMLElement | null;
    return {
      bottom: bounds.bottom,
      viewport: window.innerHeight,
      listScrolls: list ? list.scrollHeight > list.clientHeight : false,
      pageScrolls: container ? container.scrollHeight > container.clientHeight : false,
    };
  });
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewport);
  expect(layout.listScrolls).toBe(true);
  expect(layout.pageScrolls).toBe(false);

  // A short window is where the old 160 px floor pushed the menu past the edge:
  // the limit follows the resize and the menu still ends inside the window.
  await page.setViewportSize({ width: 800, height: 380 });
  await expect.poll(async () => menu.evaluate(element => Math.round(element.getBoundingClientRect().bottom)), { timeout: 3_000 }).toBeLessThanOrEqual(380);
  const shrunk = await menu.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, viewport: window.innerHeight, maxHeight: parseFloat(getComputedStyle(element).maxHeight) };
  });
  expect(shrunk.bottom).toBeLessThanOrEqual(shrunk.viewport);
  expect(shrunk.top).toBeGreaterThanOrEqual(0);
  expect(shrunk.maxHeight).toBeLessThanOrEqual(shrunk.viewport);

  // Opening the menu in a short window has only the room below the button: the
  // floor is gone, so the menu fits from the first paint.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.getByRole("button", { name: "Choose workspace" }).click();
  await expect(menu).toBeVisible();
  await expect.poll(async () => menu.evaluate(element => Math.round(element.getBoundingClientRect().bottom)), { timeout: 3_000 }).toBeLessThanOrEqual(380);
});
