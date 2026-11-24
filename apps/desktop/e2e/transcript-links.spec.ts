import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #201: a transcript link in a browser client. The window that has no
 * native shell opens the link itself, in a new tab; it never answers
 * "Could not open link.", which was a Tauri command a browser does not have.
 *
 * Runs the built UI (dist/) against a real host and the fake runtime, with the
 * endpoint the desktop shell would inject — the same client a paired phone runs.
 * Build both first: `npm run build` and `cargo build` in host/.
 */
const root = resolve(import.meta.dirname, "..");
const hostBin = process.env.JOUZU_HOST_BIN
  ?? join(root, "host", "target", "debug", process.platform === "win32" ? "jouzu-host.exe" : "jouzu-host");
const dist = join(root, "dist");
const docs = "https://example.com/docs?page=1";

test.skip(!existsSync(hostBin) || !existsSync(join(dist, "index.html")), "build the UI and the host first");

let host: ChildProcess | undefined;
let scratch = "";
test.afterEach(() => {
  host?.kill();
  // The host may still hold a file for a moment after the kill.
  if (scratch) try { rmSync(scratch, { recursive: true, force: true }); } catch { /* removed on the next run */ }
});

async function startHost(home: string, runtimeHome: string, node: string) {
  const child = spawn(hostBin, ["--dist", dist, "--home", home, "--runtime-home", runtimeHome], {
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, JOUZU_HOST_NODE: node },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = await new Promise<{ port: number; token: string }>((done, fail) => {
    let text = "";
    const timer = setTimeout(() => fail(new Error("the host did not start")), 20_000);
    child.stdout!.on("data", chunk => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      child.stdout!.removeAllListeners("data");
      child.stdout!.resume();
      done(JSON.parse(text.slice(0, end)));
    });
  });
  return { child, base: `http://127.0.0.1:${ready.port}`, token: ready.token };
}

test("a link in the transcript opens a new tab, not a desktop-only error (#201)", async ({ page, context }) => {
  await context.route("https://example.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<p>docs</p>" }));
  scratch = mkdtempSync(join(tmpdir(), "jouzu-transcript-links-"));
  const home = join(scratch, "home");
  const runtimeHome = join(scratch, "runtime");
  const node = join(scratch, "node", "bin", "node");
  mkdirSync(join(scratch, "node", "bin"), { recursive: true });
  symlinkSync(process.execPath, node);
  mkdirSync(join(home, "app"), { recursive: true });
  copyFileSync(join(root, "host", "tests", "fixtures", "fake-runtime.mjs"), join(home, "app", "bootstrap.mjs"));
  const folder = join(scratch, "ui-test");
  mkdirSync(folder);

  let started = await startHost(home, runtimeHome, node);
  host = started.child;
  const call = async (base: string, token: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const created = await call(started.base, started.token, "/v1/sessions", { workspacePath: folder, sessionPath: null, clientId: "setup" });
  const id = created.body.sessionId;
  await call(started.base, started.token, `/v1/sessions/${id}/messages`, { clientMessageId: "m1", text: "read this", clientId: "setup" });
  let saved: string | null = null;
  for (let i = 0; i < 50 && !saved; i++) {
    await new Promise(r => setTimeout(r, 200));
    const list = await call(started.base, started.token, "/v1/sessions");
    saved = list.body.sessions.find((s: { sessionId: string }) => s.sessionId === id)?.sessionPath ?? null;
  }
  expect(saved).toBeTruthy();
  await new Promise(r => setTimeout(r, 1000));
  // A file with no message is never listed (#92), so the reply comes with the
  // user message that started it. The assistant message holds the link.
  appendFileSync(saved!,
    `${JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "read this" }] } })}\n`
    + `${JSON.stringify({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: `See [the docs](${docs}).` }] } })}\n`);
  host.kill();
  await new Promise(r => setTimeout(r, 500));

  started = await startHost(home, runtimeHome, node);
  host = started.child;
  await page.addInitScript(([url, value]) => {
    (window as unknown as { __JOUZU_HOST__?: unknown }).__JOUZU_HOST__ = { baseUrl: url, token: value };
    localStorage.setItem("jouzu.ui.language", "en");
  }, [started.base, started.token]);
  await page.goto(started.base);
  await page.getByText("read this").first().click();

  const link = page.getByRole("link", { name: "the docs" });
  await expect(link).toBeVisible({ timeout: 15_000 });
  // The anchor is the handler on a browser client: a new tab, opener cut off.
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const [opened] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await expect(opened).toHaveURL(docs);
  await expect(page.getByText("Could not open link.")).toHaveCount(0);
});
