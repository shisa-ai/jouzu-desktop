import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The runtime's files are gone (a disk cleanup removed them). The host refuses
 * every session with runtime-missing; the window must leave its loading screen
 * and say what is wrong at the start page, not stay on "Connecting…".
 *
 * Runs the built UI (dist/) against a real host binary with no runtime installed
 * under its home. Build both first: `npm run build` and `cargo build` in host/.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let scratch = "";

test.afterEach(() => {
  host?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

for (const [language, sentence] of [
  ["en", "Jouzu's runtime files are missing. Repair the installation in Settings to continue."],
  ["ja", "Jouzu のランタイムファイルがありません。設定からインストールを修復してください。"],
] as const) {
  test(`missing runtime files are said at the start page (${language})`, async ({ page }) => {
    scratch = mkdtempSync(join(tmpdir(), "jouzu-runtime-missing-"));
    host = spawn(hostBin, ["--dist", dist, "--home", join(scratch, "home"), "--runtime-home", join(scratch, "runtime")], {
      env: { ...process.env, HOME: scratch, USERPROFILE: scratch, JOUZU_HOST_NODE: join(scratch, "no-node") },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error("the host did not start")), 20_000);
      host!.stdout!.on("data", chunk => {
        text += chunk;
        const end = text.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        host!.stdout!.removeAllListeners("data");
        host!.stdout!.resume();
        done(JSON.parse(text.slice(0, end)));
      });
    });
    const base = `http://127.0.0.1:${ready.port}`;
    await page.addInitScript(([url, value, lang]) => {
      (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
      localStorage.setItem("jouzu.ui.language", lang);
    }, [base, ready.token, language]);
    await page.goto(base);
    const alert = page.locator("[data-session-blocked]");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(sentence);
    await expect(page.getByText(/Connecting to Jouzu/i)).toHaveCount(0);
  });
}
