import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #111: the host stops the session the window shows. A stopped session is
 * still that session: the window keeps its transcript and model, Send stays
 * usable, and the next message starts a runtime for it in the host. It must never
 * stay on "Starting session…" or mark the message "not sent".
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

test.beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "jouzu-session-stopped-"));
  const home = join(scratch, "home");
  host = spawn(hostBin, [
    "--dist", dist, "--home", home, "--runtime-home", join(scratch, "runtime"),
    "--runtime", process.execPath, "--runtime-arg", fixture,
  ], { env: { ...process.env, HOME: scratch, USERPROFILE: scratch }, stdio: ["ignore", "pipe", "ignore"] });
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

test("the session the window shows takes the next message after the host stopped it", async ({ page }) => {
  // The fixture runtime has no model catalog; offer its one model.
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
  // The fixture answers with the prompt: the user row and the reply.
  await expect(conversation.getByText("first message")).toHaveCount(2, { timeout: 15_000 });

  const { sessions } = await api("/v1/sessions");
  const bound = sessions.find((session: { title?: string }) => session.title === "first message");
  // The fixture runtime does not write its transcript; write it as the real runtime does.
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(bound.sessionPath, line("user", "first message") + line("assistant", "first message"));

  // What the idle reaper does to it.
  await api(`/v1/sessions/${bound.sessionId}/stop`, "POST");

  await expect(page.getByText("Starting session…")).toHaveCount(0, { timeout: 5_000 });
  await expect(conversation.getByText("first message").first()).toBeVisible({ timeout: 5_000 });

  await composer.fill("second message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("second message")).toHaveCount(2, { timeout: 15_000 });
  await expect(conversation.getByText("first message").first()).toBeVisible();
  await expect(page.getByText("Not sent")).toHaveCount(0);
  // The same host session ran it.
  const after = (await api("/v1/sessions")).sessions.filter((session: { sessionPath?: string }) => session.sessionPath === bound.sessionPath);
  expect(after.map((session: { sessionId: string }) => session.sessionId)).toEqual([bound.sessionId]);
});

test("a session stopped right after a model change sends on that model", async ({ page }) => {
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  await composer.fill("first message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("first message")).toHaveCount(2, { timeout: 15_000 });
  const { sessions } = await api("/v1/sessions");
  const bound = sessions.find((session: { title?: string }) => session.title === "first message");
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(bound.sessionPath, line("user", "first message") + line("assistant", "first message"));
  // A model change, then the host stops the session 1.5 s later.
  await page.getByRole("button", { name: "Model", exact: true }).first().click();
  await page.getByRole("menuitemradio").filter({ hasText: "Fixture Other" }).first().click();
  await page.waitForTimeout(1_500);
  await api(`/v1/sessions/${bound.sessionId}/stop`, "POST");
  // Stopped, it shows its model without waiting on a runtime.
  const model = page.getByRole("button", { name: "Model", exact: true }).first();
  await expect(model).toContainText("Fixture Other", { timeout: 5_000 });
  await expect(page.locator(".animate-spin")).toHaveCount(0);
  await composer.fill("second message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("second message")).toHaveCount(2, { timeout: 15_000 });
  await expect(model).toContainText("Fixture Other");
  const summary = await api(`/v1/sessions/${bound.sessionId}`);
  expect(JSON.stringify(summary)).toContain("other");
});

test("a saved session opened from the sidebar shows its own model and sends on it", async ({ page }) => {
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [base, token]);
  await page.goto(base);
  const composer = page.getByRole("textbox", { name: /message/i }).first();
  const conversation = page.getByRole("region", { name: /conversation/i }).first();
  const model = page.getByRole("button", { name: "Model", exact: true }).first();
  await composer.fill("alpha message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("alpha message")).toHaveCount(2, { timeout: 15_000 });
  await expect(model).toContainText("fixture-model");
  const alpha = (await api("/v1/sessions")).sessions.find((session: { title?: string }) => session.title === "alpha message");
  const line = (role: string, text: string) => `${JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: Date.now() } })}\n`;
  appendFileSync(alpha.sessionPath, line("user", "alpha message") + line("assistant", "alpha message"));
  await api(`/v1/sessions/${alpha.sessionId}/stop`, "POST");
  // Another session, on another model.
  await page.getByRole("button", { name: /new session/i }).first().click();
  await model.click();
  await page.getByRole("menuitemradio").filter({ hasText: "Fixture Other" }).first().click();
  await expect(model).toContainText("Fixture Other");
  await composer.fill("beta message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("beta message")).toHaveCount(2, { timeout: 15_000 });
  // Back to alpha (stopped): its own model, never beta's, and no spinner while it opens.
  await page.getByText("alpha message").first().click();
  for (let sample = 0; sample < 40; sample += 1) {
    expect(await model.textContent()).not.toContain("Fixture Other");
    expect(await model.locator(".animate-spin").count()).toBe(0);
    await page.waitForTimeout(10);
  }
  await expect(model).toContainText("fixture-model", { timeout: 5_000 });
  await expect(model).not.toContainText("Fixture Other");
  // A pick on it, then the host stops it again: the message goes out on the pick.
  await model.click();
  await page.getByRole("menuitemradio").filter({ hasText: "Fixture Other" }).first().click();
  await expect(model).toContainText("Fixture Other");
  for (const session of (await api("/v1/sessions")).sessions.filter((item: { sessionPath?: string }) => item.sessionPath === alpha.sessionPath)) {
    await api(`/v1/sessions/${session.sessionId}/stop`, "POST");
  }
  await composer.fill("gamma message");
  await page.getByRole("button", { name: /^send$/i }).first().click();
  await expect(conversation.getByText("gamma message")).toHaveCount(2, { timeout: 15_000 });
  await expect(model).toContainText("Fixture Other");
  await expect(page.getByText("Not sent")).toHaveCount(0);
});
