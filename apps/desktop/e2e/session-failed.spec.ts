import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #95: the host gives up on the session the window shows (here: its
 * runtime died and the replacement refuses to open the session file, as Flow
 * does with storage it cannot own). The window must not keep a turn waiting:
 * it shows why, offers "Restart session", and after a restart the next
 * message goes through.
 *
 * Runs the built UI (dist/) against a real host binary with the fixture runtime,
 * on a throwaway home. Build both first: `npm run build` and `cargo build` in host/.
 * JOUZU_HOST_BIN overrides the host binary.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");
const fixture = join(root, "host", "tests", "fixtures", "fake-runtime.mjs");

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let base = "";
let token = "";
let scratch = "";
let refusal = "";

test.beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jouzu-session-failed-"));
  const home = join(scratch, "home");
  refusal = join(scratch, "refuse-switch.txt");
  host = spawn(hostBin, [
    "--dist", dist, "--home", home, "--runtime-home", join(scratch, "runtime"),
    "--runtime", process.execPath, "--runtime-arg", fixture,
  ], { env: { ...process.env, HOME: scratch, USERPROFILE: scratch, FAKE_RUNTIME_SWITCH_ERROR_FILE: refusal }, stdio: ["ignore", "pipe", "ignore"] });
  // The host gives its port and API token on its first output line (#130).
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
  base = `http://127.0.0.1:${ready.port}`;
  token = ready.token;
  expect(token, "the host gave its token").not.toBe("");
});

test.afterEach(() => {
  host?.kill();
  rmSync(scratch, { recursive: true, force: true });
});

const api = async (path: string, method = "GET") => {
  const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
  return response.json();
};

test("a failed session ends its turn, says why and restarts on request", async ({ page }) => {
  await page.route("**/v1/models", route => route.fulfill({ json: { models: [{ id: "model", name: "fixture-model", provider: "fixture", available: true }] } }));
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  await page.getByRole("button", { name: /model/i }).first().click({ timeout: 20_000 });
  await page.getByText("fixture-model").last().click();
  await composer.fill("first message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("first message")).toHaveCount(2, { timeout: 15_000 });

  const { sessions } = await api("/v1/sessions");
  const bound = sessions.find((session: { title?: string }) => session.title === "first message");
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(bound.sessionPath, line("user", "first message") + line("assistant", "first message"));

  // The runtime dies; every replacement refuses the session file.
  writeFileSync(refusal, "Flow session metadata is missing or inconsistent.");
  const info = await api(`/v1/sessions/${bound.sessionId}`);
  process.kill(info.runtimePid);

  // The one session-level error takes the composer's place: why, and the one way back.
  const alert = page.locator("[data-session-blocked]");
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toContainText("The runtime could not open this session.");
  await expect(composer).toHaveCount(0);
  // Nothing is left waiting: no timer, no Stop.
  await expect(page.getByRole("button", { name: /^stop/i })).toHaveCount(0);
  await expect(page.getByText(/waiting for model/i)).toHaveCount(0);
  const status = (await api("/v1/sessions")).sessions.find((session: { sessionPath?: string }) => session.sessionPath === bound.sessionPath);
  expect(status.status).toBe("error");
  expect(status.activeTurn ?? null).toBeNull();

  // The cause is gone: restart, and the conversation carries on.
  rmSync(refusal);
  await page.getByRole("button", { name: "Restart session" }).click();
  await expect(alert).toHaveCount(0, { timeout: 10_000 });
  await expect(conversation.getByText("first message").first()).toBeVisible();
  await composer.fill("second message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("second message")).toHaveCount(2, { timeout: 15_000 });
});
