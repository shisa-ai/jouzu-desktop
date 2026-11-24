import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { emptyControlState, stubHost, type Workspace } from "./host-control";

test.use({ channel: process.env.JOUZU_UI_TEST_BROWSER });

// Issue #19: the default workspace is the fixed way back into the app. With many
// workspaces it must stay in view — pinned below the scrolling list, above
// Settings, in the sidebar and in the picker — whatever the sort or the search.

const defaultPath = "C:/Users/demo/Documents/Jouzu/default-workspace";
const workspaces: Workspace[] = [
  ...Array.from({ length: 50 }, (_, index) => {
    const path = `C:/Projects/Workspace ${String(index).padStart(2, "0")}`;
    return { id: `windows:${path}`, path, environment: { kind: "windows" as const } };
  }),
  { id: `windows:${defaultPath}`, path: defaultPath, environment: { kind: "windows" } },
];

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 720 });
  await stubHost(page, { control: () => ({ ...emptyControlState, modelReady: true }), workspaces });
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
}

/** Where the pinned default group sits relative to the list that scrolls above it. */
const placement = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const list = document.querySelector("[data-session-list]") as HTMLElement | null;
  const pinned = document.querySelector("[data-default-workspace]") as HTMLElement | null;
  if (!list || !pinned) return null;
  const listBounds = list.getBoundingClientRect();
  const pinnedBounds = pinned.getBoundingClientRect();
  return {
    listScrolls: list.scrollHeight > list.clientHeight,
    pinnedBelowList: pinnedBounds.top >= listBounds.bottom - 1,
    pinnedInView: pinnedBounds.top >= 0 && pinnedBounds.bottom <= window.innerHeight,
  };
});

test("the default workspace stays pinned below 50 workspaces, and sorting or searching does not move it", async ({ page }) => {
  await open(page);
  const pinned = page.locator("[data-default-workspace]").first();
  await expect(pinned.getByRole("button", { name: "Collapse Default workspace" })).toBeVisible();
  expect(await placement(page)).toEqual({ listScrolls: true, pinnedBelowList: true, pinnedInView: true });

  // Sorting re-orders the list above it; the pinned group does not move.
  await page.getByRole("button", { name: "Sort by name" }).click();
  expect(await placement(page)).toEqual({ listScrolls: true, pinnedBelowList: true, pinnedInView: true });

  // A search that matches it keeps it where it is.
  await page.getByRole("button", { name: "Search workspaces" }).click();
  await page.getByRole("textbox", { name: "Search sessions" }).fill("Jouzu");
  // Only the default workspace matches, and it is still the pinned one.
  await expect(page.locator("[data-session-list]").getByRole("button")).toHaveCount(0);
  expect(await placement(page)).toEqual({ listScrolls: false, pinnedBelowList: true, pinnedInView: true });
});

test("the picker pins the default workspace too, and has one entry for it", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Choose workspace" }).click();
  const menu = page.getByRole("menu", { name: "Choose workspace" });
  await expect(menu).toBeVisible();
  const pinned = menu.locator("[data-default-workspace]");
  await expect(pinned.getByRole("menuitemradio", { name: /Default workspace/ })).toBeVisible();
  const layout = await menu.evaluate(element => {
    const list = element.querySelector("[data-workspace-list]") as HTMLElement;
    const fixed = element.querySelector("[data-default-workspace]") as HTMLElement;
    return {
      listScrolls: list.scrollHeight > list.clientHeight,
      pinnedBelowList: fixed.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 1,
      pinnedInView: fixed.getBoundingClientRect().bottom <= window.innerHeight,
    };
  });
  expect(layout).toEqual({ listScrolls: true, pinnedBelowList: true, pinnedInView: true });
  // One default workspace, however many spellings the list holds.
  await expect(menu.getByRole("menuitemradio", { name: /Default workspace/ })).toHaveCount(1);

  // Selecting it opens that workspace.
  await pinned.getByRole("menuitemradio", { name: /Default workspace/ }).click();
  await expect(page.getByRole("button", { name: "Choose workspace" })).toContainText("Default workspace");
});
