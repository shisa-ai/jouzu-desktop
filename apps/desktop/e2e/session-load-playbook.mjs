import { chromium } from "@playwright/test";

/** Black-box session-load playbook. Uses visible actions and a unique reply. */
const cdp = process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223";
const count = Math.max(1, Number(process.env.PLAYBOOK_SESSIONS ?? 10));
const out = process.env.PLAYBOOK_OUT;
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
const now = () => Date.now();
const runs = [];
const errors = [];
const newSession = () => page.getByRole("button", { name: /new session/i }).first();
const composer = () => page.getByRole("textbox", { name: /message/i }).first();
const send = () => page.getByRole("button", { name: /^send$/i }).first();

page.on("pageerror", error => errors.push(String(error)));
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

for (let index = 1; index <= count; index += 1) {
  const start = now();
  try {
    await newSession().click();
    await composer().waitFor({ timeout: 15_000 });
    const ready = now() - start;
    const product = 13 * index;
    await composer().fill(`What is 13 × ${index}? Reply with only the number.`);
    const sent = now();
    await send().click();
    await page.getByText(String(product), { exact: true }).first().waitFor({ timeout: 30_000 });
    const reply = now() - sent;
    const ok = !(await page.locator("body").innerText()).includes("Sending…");
    runs.push({ index, ready, reply, ok });
    console.log(`SESSION ${index} ready=${ready} reply=${reply} ok=${ok}`);
    if (!ok) break;
  } catch (error) {
    errors.push(String(error?.stack ?? error));
    await page.screenshot({ path: `${process.env.TEMP}\\playbook-load-${index}.png` }).catch(() => {});
    runs.push({ index, ok: false });
    break;
  }
}

const summary = {
  startedAt: new Date().toISOString(),
  requested: count,
  completed: runs.filter(run => run.ok).length,
  runs,
  errors,
};
console.log(JSON.stringify(summary, null, 2));
if (out) await (await import("node:fs/promises")).writeFile(out, JSON.stringify(summary, null, 2));
await browser.close();
