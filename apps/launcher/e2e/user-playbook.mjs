import { chromium } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Black-box user playbook. It uses accessible actions, visible text and a unique
 * reply sentinel only. It never reads host logs, endpoints, DOM structure or
 * layout; the one exception is the reply language check, which reads the saved
 * session (PLAYBOOK_DATA_DIR) because what Desktop owns is the instruction it sends,
 * not the language the model answers in. UI changes may require updating only the
 * semantic locators below.
 *
 * Controls are found by the words the app renders, taken from its own text tables
 * in the app's current interface language, so the playbook runs in any of them.
 * PLAYBOOK_LOCALE=en|ja|zh-Hans|zh-Hant switches the app to that language first.
 * The tables are TypeScript, imported with Node's type stripping (Node 22.18+).
 */
const cdp = process.env.PLAYBOOK_CDP ?? "http://127.0.0.1:9223";
const out = process.env.PLAYBOOK_OUT;
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].newPage();
const result = { startedAt: new Date().toISOString(), metrics: {}, gates: {}, scenarios: [], errors: [] };
const mark = async (name, ms) => { result.metrics[name] = Math.round(ms); };
const scenario = (name, ok, detail = "") => result.scenarios.push({ name, ok, detail });
const now = () => Date.now();
const assertGate = (name, value, limit) => {
  result.gates[name] = { value, limit, ok: value <= limit };
};
/**
 * A timing measured several times is judged by its median and its slowest sample,
 * never by one sample: one slow sample is noise, a slow median is the product.
 * Limits (why each number):
 * - 100 ms: the user sees their own action answered at once (own message, the turn
 *   visibly working). Nothing has to leave the machine for it.
 * - slowest <= 2x the limit: an occasional hiccup is tolerated, a pattern is not.
 */
const assertRepeatedGate = (name, samples, limit) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const slowest = sorted[sorted.length - 1];
  result.metrics[name] = median;
  result.metrics[`${name}Slowest`] = slowest;
  result.gates[name] = { value: median, slowest, samples: sorted, limit, slowestLimit: limit * 2, ok: median <= limit && slowest <= limit * 2 };
};
const record = (name, samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  result.metrics[name] = sorted[Math.floor((sorted.length - 1) / 2)];
  result.metrics[`${name}Slowest`] = sorted[sorted.length - 1];
  result.samples = { ...(result.samples ?? {}), [name]: sorted };
};

// The words the app shows, in the language it is set to (#101): the playbook finds
// controls by the same text tables the app renders from, so it runs in every
// interface language. PLAYBOOK_LOCALE switches the app to one first.
const { messages, resolveLocale } = await import("../src/i18n.ts");
const { chatTexts } = await import("../src/chat-text.ts");
const { webAccessText } = await import("../src/web-access-text.ts");
if (process.env.PLAYBOOK_LOCALE) {
  await page.evaluate(locale => localStorage.setItem("jouzu.ui.language", locale), resolveLocale(process.env.PLAYBOOK_LOCALE));
  await page.reload();
}
const locale = resolveLocale(await page.evaluate(() => document.documentElement.lang || localStorage.getItem("jouzu.ui.language") || navigator.language));
const L = messages[locale];
const C = chatTexts[locale];
const W = webAccessText[locale];
result.locale = locale;
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const either = (...texts) => new RegExp(`^(?:${texts.map(literal).join("|")})$`);

page.on("pageerror", error => result.errors.push(String(error)));
page.on("console", message => {
  if (message.type() === "error" && !/Failed to load resource/.test(message.text())) result.errors.push(message.text());
});

const newSession = () => page.getByRole("button", { name: C.newSession, exact: true }).first();
const composer = () => page.getByRole("textbox", { name: C.messageJouzu, exact: true }).first();
const send = () => page.getByRole("button", { name: C.send, exact: true }).first();
const stop = () => page.getByRole("button", { name: C.stop, exact: true }).first();
const conversation = () => page.getByRole("region", { name: C.conversation, exact: true }).first();

async function waitForConversationText(text, timeout = 30_000) {
  await conversation().getByText(text, { exact: true }).first().waitFor({ timeout });
}

/**
 * Times "own message visible" and "working visible" inside the page, so the number is
 * the app's: from the Send click event (event.timeStamp) to the animation frame in
 * which the message (one more copy of `text` in the Conversation region) and the Stop
 * button are in the DOM. Measured from outside, the same moments also hold the
 * driver's actionability checks, CDP round trips and polling backoff.
 */
async function armVisibleTimer(text) {
  await page.evaluate(([text, regionName, stopName]) => {
    window.__jouzuVisibleTimer?.observer.disconnect();
    const region = () => document.querySelector(`section[aria-label="${CSS.escape(regionName)}"], [role="region"][aria-label="${CSS.escape(regionName)}"]`);
    const copies = () => (region()?.textContent ?? "").split(text).length - 1;
    const stopShown = () => [...document.querySelectorAll("button")].some(b => (b.getAttribute("aria-label") || b.textContent || "").trim() === stopName);
    const state = { click: null, own: null, stop: null, before: copies() };
    const frame = key => { const seen = performance.now(); requestAnimationFrame(() => { state[key] = performance.now(); state[`${key}Dom`] = seen; }); };
    const check = () => {
      if (state.click == null) return;
      if (state.ownDom === undefined && copies() > state.before) { state.ownDom = null; frame("own"); }
      if (state.stopDom === undefined && stopShown()) { state.stopDom = null; frame("stop"); }
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener("click", event => { if (state.click == null) { state.click = event.timeStamp; check(); } }, { capture: true, once: true });
    window.__jouzuVisibleTimer = { state, observer };
  }, [text, C.conversation, C.stop]);
}

/** Milliseconds from the click to the frame showing each; null when not seen. */
async function readVisibleTimer() {
  return page.evaluate(() => {
    const timer = window.__jouzuVisibleTimer;
    timer?.observer.disconnect();
    const s = timer?.state ?? {};
    const since = at => (s.click == null || at == null ? null : Math.round(at - s.click));
    return { own: since(s.own), stop: since(s.stop) };
  });
}

/** A 32×32 solid red PNG, built here so the playbook needs no fixture file. */
async function redSquarePng() {
  const { deflateSync } = await import("node:zlib");
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = bytes => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const size = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * An image the user sent stays in its message after switching sessions (#119).
 * Measures: the message's image is visible again after switching to another
 * session and back. Why: the transcript shown again is rebuilt from the app's
 * history, which once had no way to show a message's image. `otherPrompt` is a
 * visible prompt of another saved session to switch to.
 */
async function imageSurvivesSessionSwitch(otherPrompt) {
  const name = "Image in a sent message stays after switching sessions (#119)";
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const chooser = page.getByLabel(C.chooseImages, { exact: true });
  if (!await chooser.count()) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "the selected model takes no images" });
    return;
  }
  const imagePrompt = "What color is this square? Reply with one word.";
  await chooser.setInputFiles({ name: "red-square.png", mimeType: "image/png", buffer: await redSquarePng() });
  await page.getByRole("list", { name: C.attachedImages }).waitFor({ timeout: 10_000 });
  await composer().fill(imagePrompt);
  await send().click();
  await waitForConversationText(imagePrompt, 5_000);
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await send().waitFor({ timeout: 60_000 });
  const sentImage = () => conversation().getByRole("img", { name: C.conversationAttachment }).first();
  const before = await sentImage().isVisible();
  await page.getByText(otherPrompt, { exact: false }).first().click();
  await conversation().getByText(otherPrompt, { exact: false }).first().waitFor({ timeout: 10_000 });
  await page.getByText(imagePrompt, { exact: true }).first().click();
  await waitForConversationText(imagePrompt, 10_000);
  const after = await sentImage().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  scenario(name, before && after, `visible before switching: ${before}; after switching back: ${after}`);
  await page.screenshot({ path: process.env.TEMP + "\\playbook-02-image-switch.png" });
}

/**
 * Image tool with a provider other than Shisa (#65). The provider list comes
 * from the runtime's model catalog, so a provider with a credential in the test
 * data directory must be listed, selectable and able to generate; switching
 * back to Shisa must still work. PLAYBOOK_IMAGE_PROVIDER names the provider as
 * the Tools page labels it (e.g. "OpenRouter"); without it the scenario is
 * recorded as skipped, never as passed.
 */
async function imageProviderScenario() {
  const name = "P1-image other provider (#65)";
  const label = process.env.PLAYBOOK_IMAGE_PROVIDER;
  if (!label) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "PLAYBOOK_IMAGE_PROVIDER not set" });
    return;
  }
  const openTools = async () => {
    await page.getByRole("button", { name: C.settings, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: L.toolsTab, exact: true }).click();
    await dialog.getByText(C.imageGeneration, { exact: true }).waitFor({ timeout: 10_000 });
    return dialog;
  };
  const closeSettings = () => page.keyboard.press("Escape");
  let dialog = await openTools();
  const provider = dialog.getByLabel(C.imageProvider);
  const model = dialog.getByLabel(C.imageModel);
  const original = await provider.inputValue();
  const options = await provider.locator("option").allTextContents();
  const listed = options.includes(label);
  if (!listed) {
    scenario(name, false, `"${label}" not offered with a credential; options: ${options.join(", ")}`);
    await closeSettings();
    return;
  }
  await provider.selectOption({ label });
  await page.waitForFunction(element => !element.disabled && element.options.length > 0 && element.value, await model.elementHandle(), { timeout: 20_000 });
  const chosenModel = await model.inputValue();
  await closeSettings();

  // Generate one image through the chat, approving the reviewed call.
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await composer().fill("Use the generate_image tool once to draw a small red circle on white. Do not ask questions.");
  await send().click();
  await page.getByRole("button", { name: "Approve", exact: true }).first().click({ timeout: 60_000 });
  await conversation().getByText(/Generated 1 image/).first().waitFor({ timeout: 180_000 });
  const generated = await conversation().getByRole("img").count() > 0;
  await page.screenshot({ path: process.env.TEMP + "\\playbook-image-provider.png" });

  // Back to Shisa, and back to whatever was configured before.
  dialog = await openTools();
  await provider.selectOption("shisa");
  await page.waitForFunction(element => !element.disabled && element.value, await model.elementHandle(), { timeout: 20_000 });
  const shisaModel = await model.inputValue();
  if (original !== "shisa") await provider.selectOption(original);
  await closeSettings();
  scenario(name, generated && Boolean(shisaModel), `provider ${label}, model ${chosenModel}; Shisa model ${shisaModel || "none"}`);
}

const settingsDialog = () => page.getByRole("dialog").first();
/**
 * Web access (#91, #106). Measures: with web access on, a browser must pair before
 * it sees anything; a paired browser gets the full UI with no page error; a removed
 * device is sent back to pairing; off closes the port. Why: who may connect was fixed
 * in code and invisible, and plain-http access from another device crashed the UI
 * (crypto.randomUUID is missing outside a secure context). When this machine has a
 * local-network address the same check runs over it, which is a non-secure origin.
 * Web access is set back to Off at the end.
 */
async function webAccessScenario() {
  // Web access is managed only from the app's own window: a browser client gets no
  // Web access tab (it must not widen who can connect). Where the playbook drives the
  // UI in a browser (the stable release exam), this part is recorded as not run.
  if (!await page.evaluate(() => "__TAURI_INTERNALS__" in window)) {
    result.scenarios.push({ name: "Web access (#91, #106)", ok: true, skipped: true, detail: "not run: the UI runs in a browser; Web access is managed only in the app window" });
    return;
  }
  const visitor = await chromium.launch();
  const openWebAccess = async () => {
    await openSettingsTab(W.title);
    return settingsDialog();
  };
  const choose = async (dialog, option) => {
    await dialog.getByRole("combobox", { name: W.scope }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  const save = async dialog => {
    const button = dialog.getByRole("button", { name: W.save, exact: true });
    if (await button.count()) await button.click();
  };
  const visit = async url => {
    const context = await visitor.newContext();
    const tab = await context.newPage();
    const errors = [];
    tab.on("pageerror", error => errors.push(String(error)));
    await tab.goto(url);
    await tab.waitForTimeout(3_000);
    return { context, tab, errors };
  };
  try {
    let dialog = await openWebAccess();
    await choose(dialog, W.networks);
    const lan = dialog.getByRole("switch").first();
    const hasNetwork = await lan.count() > 0;
    if (hasNetwork) {
      if ((await lan.getAttribute("aria-checked")) !== "true") await lan.click();
    } else {
      await choose(dialog, W.local);
    }
    await save(dialog);
    await dialog.getByText(new RegExp(`${literal(W.serving)}:`)).waitFor({ timeout: 15_000 });
    await dialog.getByRole("button", { name: W.pair }).click();
    // The pairing links render after the click: read them once they are there.
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] input, [role="dialog"] textarea')].some(node => node.value.includes("/pair?code=")), null, { timeout: 15_000 });
    const links = await dialog.getByRole("textbox").evaluateAll(nodes => nodes.map(node => node.value).filter(value => value.includes("/pair?code=")));
    const local = links.find(url => url.startsWith("http://127.0.0.1:"));
    const network = links.find(url => !url.startsWith("http://127.0.0.1:"));
    // With the network on, the pairing links may name only network addresses; this
    // computer's address is the one "Serving at" lists.
    const serving = await dialog.getByText(new RegExp(`${literal(W.serving)}:`)).innerText();
    const base = local ? new URL(local).origin : /http:\/\/127\.0\.0\.1:\d+/.exec(serving)?.[0];
    if (!base) throw new Error(`no address on this computer in: ${serving}`);

    // Unpaired: pairing page only.
    const stranger = await visit(base + "/");
    scenario("Web access: an unpaired browser only sees the pairing page (#91)", stranger.tab.url().endsWith("/pair"), stranger.tab.url());
    await stranger.context.close();

    // Paired over this computer, then (if present) over the local network.
    const paired = await visit(network ?? local);
    const pairedOk = !paired.tab.url().includes("/pair") && paired.errors.length === 0;
    scenario(
      network ? "Web access: a browser paired over the local network loads the app with no page error (#91, #106)" : "Web access: a paired browser loads the app with no page error (#91)",
      pairedOk,
      `${paired.tab.url()} ${paired.errors.join(" | ")}`,
    );
    await paired.tab.screenshot({ path: process.env.TEMP + "\\playbook-04-web-paired.png" }).catch(() => {});

    // Remove the device on the desktop: the browser is sent back to pairing.
    dialog = settingsDialog();
    await dialog.getByRole("button", { name: new RegExp(`^${literal(W.remove)} `) }).first().click();
    await dialog.getByText(W.noDevices).waitFor({ timeout: 10_000 });
    await paired.tab.reload();
    await paired.tab.waitForTimeout(1_000);
    scenario("Web access: a removed device is sent back to pairing (#91)", paired.tab.url().endsWith("/pair"), paired.tab.url());
    await paired.context.close();

    // Off: the port closes.
    await choose(dialog, W.off);
    await save(dialog);
    await dialog.getByText(W.offHint).waitFor({ timeout: 10_000 });
    const closed = await fetch(base + "/pair").then(() => false, () => true);
    scenario("Web access: turning it off closes the port (#91)", closed, base);
    await page.keyboard.press("Escape");
  } finally {
    await visitor.close();
  }
}

/**
 * A long saved conversation reads back to its first turn, and a branch from an
 * early turn holds that turn only (#20). The data folder must already hold a
 * saved session of PLAYBOOK_LONG_TURNS turns (default 130) whose prompts read
 * "Long session question N" and replies "Long session answer N", each turn with
 * a tool call: more than the first page the app loads.
 * e2e-runtime/long-session.mjs writes it.
 */
async function longSessionScenario() {
  const turns = Number(process.env.PLAYBOOK_LONG_TURNS ?? 130);
  const name = "A long session reads back to its first message and branches from an early turn (#20)";
  await page.getByText(/^Long session question 1$/).first().click({ timeout: 30_000 });
  await waitForConversationText(`Long session answer ${turns}`, 60_000);
  const start = now();
  // Earlier messages are either already loaded (Show N earlier) or read from the host
  // (Load earlier messages); either way the user keeps asking until neither is offered.
  // "Show N earlier messages" (already loaded, not yet shown; English only in the UI
  // today) or "Load earlier messages" (read from the host).
  const shownEarlier = /^Show \d+ earlier messages?$/;
  const earlier = () => conversation().getByRole("button").filter({ hasText: shownEarlier })
    .or(conversation().getByRole("button", { name: C.loadEarlier, exact: true })).first();
  const loading = () => conversation().getByRole("button", { name: C.loadingEarlier }).first();
  // After a click the button is replaced (loading, then the next "earlier" button);
  // the user keeps asking until none comes back. Settled: 2 s with neither shown.
  const nextOffer = async () => {
    const end = now() + 30_000;
    let quietSince = now();
    while (now() < end) {
      if (await earlier().isVisible().catch(() => false)) return true;
      if (await loading().isVisible().catch(() => false)) quietSince = now();
      else if (now() - quietSince >= 2_000) return false;
      await page.waitForTimeout(100);
    }
    return false;
  };
  let clicks = 0;
  while (await nextOffer()) {
    await earlier().click();
    clicks += 1;
    if (clicks > turns * 3) break;
  }
  await mark("longSessionToFirstMessage", now() - start);
  // textContent, not innerText: messages far off screen skip rendering (content-visibility)
  // and innerText leaves them out, though the user reaches them by scrolling.
  const text = await conversation().textContent();
  const missing = [];
  let order = -1, ordered = true;
  for (let turn = 1; turn <= turns; turn += 1) {
    const question = text.search(new RegExp(`Long session question ${turn}(?!\\d)`));
    const answer = text.search(new RegExp(`Long session answer ${turn}(?!\\d)`));
    if (question < 0 || answer < 0) missing.push(turn);
    else { ordered &&= order < question && question < answer; order = answer; }
  }
  if (missing.length || !ordered) {
    scenario(name, false, `${clicks} clicks; turns missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}; in order: ${ordered}`);
    return;
  }
  // Branch from the first turn: its footer is the first one in the conversation.
  await conversation().getByRole("button", { name: C.branchConversation }).first().click();
  // The branch opens as its own conversation: turn 1 there, the long session's last turn gone.
  await page.waitForFunction(({ last, label }) => {
    const text = document.querySelector(`[aria-label="${label}"]`)?.textContent ?? "";
    return /Long session question 1(?!\d)/.test(text) && !text.includes(`Long session answer ${last}`);
  }, { last: turns, label: C.conversation }, { timeout: 30_000 }).catch(() => {});
  const branched = await conversation().textContent();
  const has = pattern => new RegExp(`${pattern}(?!\\d)`).test(branched);
  const ok = has("Long session question 1") && has("Long session answer 1")
    && !has("Long session question 2") && !has("Long session answer 2");
  scenario(name, ok, ok ? `${turns} turns reached in ${clicks} clicks; branch holds turn 1 only` : `branch shows: ${branched.slice(0, 300)}`);
}

/**
 * The session's run belongs to one owner, the host: a message sent while a reply
 * runs is read by that reply, Stop ends it, and nothing sent is lost or shown
 * twice, whenever it was sent. PLAYBOOK_SCENARIO=run-ownership runs these only.
 * The long reply works on a real model (300 numbers take a while) and on the
 * fixture provider ("SLOW" holds the reply open).
 */
const longPrompt = "SLOW: count from 1 to 300, one number per line, nothing else.";
/**
 * Problems shown to the user. After a Stop, Flow says it paused ("Flow control
 * paused after an interrupt…"): the runtime's own notice that Stop worked, not a
 * problem, so it is not counted.
 */
// Anything shown as failed: a failure line (role=alert) or a failed mark at a control.
const alerts = () => page.locator('[role="alert"], [data-result="failed"]').filter({ hasNotText: /Flow control paused after an interrupt/i });
const queued = () => page.getByRole("region", { name: C.queuedMessages });
const userCount = text => conversation().getByText(text, { exact: true }).count();
/** The composer's submit button: "Send" when idle, "Steer" while a reply runs. */
const submit = () => page.getByRole("button", { name: either(C.send, C.steer) }).first();
/** The reply has really started writing: the fixture's marker, or a line "3" of the count. */
async function replyWriting(timeout = 60_000) {
  await page.waitForFunction(({ prompt, label }) => {
    const region = document.querySelector(`[aria-label="${label}"]`);
    const text = (region?.textContent ?? document.body.innerText).replace(prompt, "");
    return /waiting-for-steer|\b3\b/.test(text);
  }, { prompt: longPrompt, label: C.conversation }, { timeout });
}
/** Wait until `text` is shown exactly `n` times (the transcript may still be catching up). */
async function shownTimes(text, n = 1, timeout = 10_000) {
  const until = now() + timeout;
  let count = await userCount(text);
  while (count !== n && now() < until) {
    await page.waitForTimeout(200);
    count = await userCount(text);
  }
  return count;
}
/** The session is idle and stays so: Stop gone, Send back, for a second. */
async function staysIdle() {
  await page.waitForTimeout(1_000);
  return !await stop().isVisible() && await send().isVisible();
}
async function chooseModel() {
  await page.getByRole("button", { name: C.model, exact: true }).first().click();
  const modelName = new RegExp(process.env.PLAYBOOK_MODEL ?? "qwen 3\\.8 flash next", "i");
  await page.getByRole("menuitemradio").filter({ hasText: modelName }).first().click();
  await page.getByText(modelName).first().waitFor({ timeout: 5_000 });
}
async function freshSession() {
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
}
async function sendText(text, image = false) {
  if (image) {
    await page.getByLabel(C.chooseImages, { exact: true }).setInputFiles({ name: "red-square.png", mimeType: "image/png", buffer: await redSquarePng() });
    await page.getByRole("list", { name: C.attachedImages }).waitFor({ timeout: 10_000 });
  }
  await composer().fill(text);
  await submit().click();
}
async function turnEnds(timeout = 180_000) {
  await stop().waitFor({ state: "detached", timeout });
  await send().waitFor({ timeout: 10_000 });
}
/** Continue messages Stop returned, if any; then wait for the session to be idle. */
async function continueReturned() {
  const resume = queued().getByRole("button", { name: C.continue, exact: true });
  if (await resume.count()) {
    await resume.click();
    // The continued message starts a turn of its own; it may also end before Stop is seen.
    await stop().waitFor({ timeout: 5_000 }).catch(() => {});
    await turnEnds();
  }
}

async function runOwnershipScenarios() {
  const images = async () => (await page.getByLabel(C.chooseImages, { exact: true }).count()) > 0;

  // 1. Sent while a reply runs: the reply reads it (text, then text with an image);
  //    nothing is refused, nothing errors, each message shows once.
  {
    const name = "A message sent while a reply runs is read by that reply, not refused";
    await freshSession();
    await sendText(longPrompt);
    await stop().waitFor({ timeout: 10_000 });
    await replyWriting();
    const steer = "While you count: also say the word BANANA once at the end.";
    await sendText(steer);
    // Sent while the reply still ran (the button said Steer and Stop was still there).
    let duringRun = await stop().isVisible();
    const withImage = await images();
    const steerImage = "And tell me the color of this square in one word.";
    if (withImage) {
      await sendText(steerImage, true);
      duringRun &&= await stop().isVisible();
    }
    await turnEnds();
    await continueReturned();
    const counts = [await shownTimes(steer), withImage ? await shownTimes(steerImage) : 1];
    const errors = await alerts().count();
    const idle = await staysIdle();
    scenario(name, duringRun && counts.every(n => n === 1) && errors === 0 && !await queued().count() && idle, `sent during the reply: ${duringRun}; shown ${counts.join("/")} times; alerts ${errors}; image ${withImage}; idle after: ${idle}`);
    await page.screenshot({ path: process.env.TEMP + "\\playbook-run-1-steer.png" });
  }

  // 2. Stop while a reply runs, with a message waiting: the reply ends at once, the
  //    waiting message is kept (read already, or returned to continue), never lost.
  {
    const name = "Stop during a reply ends it and keeps the waiting message";
    await freshSession();
    await sendText(longPrompt);
    await stop().waitFor({ timeout: 10_000 });
    await replyWriting();
    const waiting = "After counting, say DONE.";
    await sendText(waiting);
    await page.waitForTimeout(500);
    const start = now();
    await stop().click();
    await turnEnds(10_000);
    record("stopToSendReady", [now() - start]);
    const stopMs = now() - start;
    const returned = await queued().count() > 0;
    await continueReturned();
    const shown = await shownTimes(waiting);
    const idle = await staysIdle();
    scenario(name, shown === 1 && await alerts().count() === 0 && idle, `returned to queue: ${returned}; shown ${shown} times; Stop to Send ready ${stopMs} ms; idle after: ${idle}`);
    await page.screenshot({ path: process.env.TEMP + "\\playbook-run-2-stop.png" });
  }

  // 3. Stop pressed right after Send, before anything was written: the session goes
  //    back to idle and the next message gets its reply.
  {
    const name = "Stop right after Send leaves the session usable";
    await freshSession();
    await sendText(longPrompt);
    await stop().click({ timeout: 5_000 });
    await turnEnds(10_000);
    await sendText("What is 12 × 12? Reply with only the number.");
    await waitForConversationText("144", 60_000).catch(() => {});
    await turnEnds();
    const text = await conversation().innerText();
    const idle = await staysIdle();
    scenario(name, text.includes("144") && await alerts().count() === 0 && idle, `idle after: ${idle}; ${text.slice(-200)}`);
  }

  // 4. A message (with an image when the model takes images) sent the moment a reply
  //    ends: it is neither lost nor sent twice, and it gets its own reply.
  {
    const name = "A message sent as a reply ends is neither lost nor sent twice";
    await freshSession();
    const results = [];
    // From 2: the answer 13 would match the question itself.
    for (let n = 2; n <= 4; n++) {
      await sendText(`What is 13 × ${n}? Reply with only the number.`);
      // A real model may say more than the number; the number is enough.
      await conversation().getByText(new RegExp(`\\b${13 * n}\\b`)).first().waitFor({ timeout: 60_000 });
      const edge = `Edge ${n}: what is 7 × ${n + 1}? Reply with only the number.`;
      await sendText(edge, n === 3 && await images());
      await turnEnds();
      await continueReturned();
      results.push(await shownTimes(edge));
    }
    const idle = await staysIdle();
    scenario(name, results.every(n => n === 1) && await alerts().count() === 0 && idle, `each shown ${results.join("/")} times; idle after: ${idle}`);
    await page.screenshot({ path: process.env.TEMP + "\\playbook-run-4-edge.png" });
  }
}

/** The newest saved session that holds `prompt`, read from PLAYBOOK_DATA_DIR: does its
 * language contract say Japanese, and does its system prompt carry that line? */
function sessionLanguageEvidence(prompt) {
  const dataDir = process.env.PLAYBOOK_DATA_DIR;
  if (!dataDir) return null;
  const directory = join(dataDir, "state", "sessions");
  const files = (existsSync(directory) ? readdirSync(directory, { recursive: true }) : [])
    .map(name => join(directory, String(name)))
    .filter(file => file.endsWith(".jsonl"))
    .map(file => ({ file, text: readFileSync(file, "utf8") }))
    .filter(({ text }) => text.includes(JSON.stringify(prompt).slice(1, -1)));
  const found = files.at(-1);
  if (!found) return { contract: false, prompt: false, file: "none holds the prompt" };
  const contract = found.text.split("\n").some(line => line.includes("jouzu-language-contract-v1") && /"returnLanguage":"ja"/.test(line));
  return { contract, prompt: found.text.includes("Response language: Japanese (ja)"), file: found.file };
}

async function openSettingsTab(name) {
  await page.getByRole("button", { name: C.settings, exact: true }).first().click();
  await settingsDialog().getByRole("tab", { name, exact: true }).click();
}
async function modelMenuItems() {
  await page.getByRole("button", { name: C.model, exact: true }).first().click();
  await page.getByRole("menuitemradio").first().waitFor({ timeout: 5_000 });
  const items = await page.getByRole("menuitemradio").allInnerTexts();
  return items.map(item => item.trim());
}

/**
 * Scenario: a Shisa API key saved in Settings works without restarting the app.
 * Measures: after saving SHISA_API_KEY and pressing "Refresh models", the model
 * menu gains the Shisa models and a new session using one gets a reply.
 * Why: the configuration service and the runtimes used to read saved variables
 * from the wrong file, once, at startup, so the refresh did nothing (issue #63).
 * Needs PLAYBOOK_SHISA_API_KEY (a test key, never a personal one) and a home where
 * Shisa.AI was never signed in or signed out; without the key it is reported as
 * not run, not as passed.
 */
async function shisaKeyWithoutRestart() {
  const name = "Shisa key saved in Settings works without restart";
  const key = process.env.PLAYBOOK_SHISA_API_KEY;
  if (!key) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "not run: PLAYBOOK_SHISA_API_KEY is not set" });
    return;
  }
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const before = await modelMenuItems();
  await page.keyboard.press("Escape");

  let start = now();
  await openSettingsTab(L.environment);
  await settingsDialog().getByRole("button", { name: L.addEntry }).click();
  await settingsDialog().getByRole("textbox", { name: L.variableName, exact: true }).last().fill("SHISA_API_KEY");
  await settingsDialog().getByLabel(L.variableValue, { exact: true }).last().fill(key);
  const save = settingsDialog().getByRole("button", { name: L.save, exact: true });
  await save.click();
  await save.waitFor({ state: "visible" });
  await settingsDialog().getByRole("tab", { name: L.providers, exact: true }).click();
  // The key alone counts as a Shisa.AI connection, so the refresh control appears.
  const refresh = settingsDialog().getByRole("button", { name: L.refreshModels });
  await refresh.waitFor({ timeout: 15_000 });
  await refresh.click();
  await page.waitForFunction(label => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes(label));
    return button && !button.disabled;
  }, L.refreshModels, { timeout: 30_000 });
  await page.keyboard.press("Escape");

  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const after = await modelMenuItems();
  const added = after.filter(item => !before.includes(item));
  await mark("shisaKeySavedToModelsListed", now() - start);
  if (!added.length) {
    await page.keyboard.press("Escape");
    scenario(name, false, "no new model appeared in the menu after saving the key and refreshing");
    return;
  }
  await page.getByRole("menuitemradio").filter({ hasText: added[0] }).first().click();
  start = now();
  await composer().fill("Reply with only the word OK.");
  await send().click();
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await send().waitFor({ timeout: 60_000 });
  await mark("shisaFirstTurnEnd", now() - start);
  const text = await conversation().innerText();
  scenario(name, /\bok\b/i.test(text.replace("Reply with only the word OK.", "")), `model: ${added[0]}`);
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-shisa-key.png" });
}

/**
 * Scenario: a new user's first run. On a home that was never set up the app asks
 * for the languages, then for a model connection. Shisa.AI is connected there by
 * signing in through the browser, which cannot run unattended, so the playbook
 * checks that the sign-in is offered. The rest of the first run is walked with a
 * custom provider (an OpenAI-compatible API) added on the same page:
 * PLAYBOOK_FIRST_RUN_URL, PLAYBOOK_FIRST_RUN_MODEL_ID and PLAYBOOK_FIRST_RUN_API_KEY.
 * It is saved, a new session opens on that model and gets a reply, no restart.
 */
async function firstRun() {
  const proceed = page.getByRole("button", { name: L.setupContinue, exact: true });
  const signIn = page.getByRole("button", { name: L.signIn, exact: true });
  // The app shows the chat until the runtime reports that no model is set up, then
  // the first-run pages; wait for the first-run page itself.
  await proceed.or(signIn).first().waitFor({ timeout: 120_000 });
  const start = now();
  const languagePage = await proceed.isVisible().catch(() => false);
  if (languagePage) await proceed.click();
  const offered = await signIn.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  scenario("First run asks for the languages, then offers Shisa.AI sign-in", languagePage && offered, `language page: ${languagePage}; Shisa.AI sign-in offered: ${offered}`);

  const name = "First run: a custom provider added on the setup page gives a reply without restart";
  const url = process.env.PLAYBOOK_FIRST_RUN_URL;
  const model = process.env.PLAYBOOK_FIRST_RUN_MODEL_ID;
  const key = process.env.PLAYBOOK_FIRST_RUN_API_KEY;
  if (!url || !model || !key) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "not run: PLAYBOOK_FIRST_RUN_URL, _MODEL_ID or _API_KEY is not set" });
    return;
  }
  await page.getByRole("combobox", { name: L.service, exact: true }).first().click();
  await page.getByRole("option", { name: L.customProvider, exact: true }).click();
  await page.getByLabel(L.providerId, { exact: true }).fill("exam-custom");
  await page.getByLabel(L.endpoint, { exact: true }).fill(url);
  await page.getByLabel(L.modelId, { exact: true }).fill(model);
  // Jouzu's own instructions do not fit the form's default 32K context.
  if (process.env.PLAYBOOK_FIRST_RUN_CONTEXT) await page.getByLabel(L.contextWindow, { exact: true }).fill(process.env.PLAYBOOK_FIRST_RUN_CONTEXT);
  await page.getByLabel(L.apiKey, { exact: true }).fill(key);
  await page.getByRole("button", { name: L.save, exact: true }).click();
  await newSession().waitFor({ timeout: 120_000 });
  await mark("firstRunSavedToChat", now() - start);
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const modelButton = page.getByRole("button", { name: C.model, exact: true }).first();
  const end = now() + 30_000;
  let shown = "";
  while (now() < end) {
    shown = (await modelButton.innerText().catch(() => "")).trim();
    if (shown && !either(C.selectModel, C.setUpModel).test(shown)) break;
    await page.waitForTimeout(100);
  }
  const prompt = "Reply with only the word OK.";
  await composer().fill(prompt);
  await send().click();
  await waitForConversationText(prompt, 5_000);
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await send().waitFor({ timeout: 60_000 });
  await mark("firstRunFirstTurnEnd", now() - start);
  const text = await conversation().innerText();
  scenario(name, /\bok\b/i.test(text.replace(prompt, "")), `model shown: ${shown}`);
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-first-run.png" });
}

/**
 * The first new session after the app starts (#99). Its model is the one its
 * runtime reports: the button shows it once the runtime answered. With no model
 * at all, Send is not offered and the button leads to setting one up.
 */
async function firstSessionHasModel() {
  const name = "First new session after start shows its runtime's model, or offers setup (#99)";
  await newSession().waitFor({ timeout: 30_000 });
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const modelButton = page.getByRole("button", { name: C.model, exact: true }).first();
  const label = async () => (await modelButton.innerText().catch(() => "")).trim();
  // Empty while nothing is known yet (a spinner); then a model or a setup offer.
  const end = now() + 15_000;
  while (now() < end && !await label()) await page.waitForTimeout(100);
  const shown = await label();
  if (shown && !either(C.selectModel, C.setUpModel).test(shown)) {
    scenario(name, true, `model shown: ${shown}`);
    return;
  }
  await composer().fill("model check");
  const disabled = await send().isDisabled().catch(() => false);
  scenario(name, !!shown && disabled, shown ? `no model (${shown}); Send ${disabled ? "not offered" : "still offered"}` : "the runtime never reported a model state");
  await composer().fill("");
}

try {
  // PLAYBOOK_SCENARIO=first-run: a home that was never set up, as a new user
  // has it; the stable release exam runs it on a home of its own (#86).
  if (process.env.PLAYBOOK_SCENARIO === "first-run") {
    await firstRun();
    throw Object.assign(new Error("done"), { done: true });
  }
  await firstSessionHasModel();
  let start = now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await newSession().waitFor({ timeout: 30_000 });
  await mark("reloadToReady", now() - start);

  // PLAYBOOK_SCENARIO=shisa-key runs only the Shisa key scenario. It needs a home where
  // Shisa.AI was never connected, while the main flow needs a working model, so the
  // stable release exam runs it on a home of its own (#86).
  if (process.env.PLAYBOOK_SCENARIO === "shisa-key") {
    await shisaKeyWithoutRestart();
    throw Object.assign(new Error("done"), { done: true });
  }
  // PLAYBOOK_SCENARIO=long-session runs only the long session scenario, on a home
  // that holds the long saved session (#20).
  if (process.env.PLAYBOOK_SCENARIO === "long-session") {
    await longSessionScenario();
    throw Object.assign(new Error("done"), { done: true });
  }
  // PLAYBOOK_SCENARIO=run-ownership runs only the run scenarios (send during a
  // reply, Stop, sending as a reply ends).
  if (process.env.PLAYBOOK_SCENARIO === "run-ownership") {
    // Start from the chat, whatever an earlier run left open.
    await page.keyboard.press("Escape");
    await freshSession();
    await chooseModel();
    await runOwnershipScenarios();
    throw Object.assign(new Error("done"), { done: true });
  }

  // P0-1: new session, own message, model, one turn.
  start = now();
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await mark("newSessionUsable", now() - start);

  start = now();
  await page.getByRole("button", { name: C.model, exact: true }).first().click();
  // PLAYBOOK_MODEL names another model (e.g. "Deterministic" on the fixture provider).
  const modelName = new RegExp(process.env.PLAYBOOK_MODEL ?? "qwen 3\\.8 flash next", "i");
  const model = page.getByRole("menuitemradio").filter({ hasText: modelName }).first();
  await model.waitFor({ timeout: 5_000 });
  await mark("modelMenuVisible", now() - start);
  await model.click();
  await page.getByText(modelName).first().waitFor({ timeout: 5_000 });
  scenario("P0-4 model selection", true);

  // The first turn of a new session, PLAYBOOK_REPEAT times (default 5), each in a
  // session of its own on the selected model.
  // Gated (the app's own work): own message visible, the turn visibly working (Stop),
  // timed inside the page: from the Send click event to the frame that shows it.
  // Recorded only: the answer itself. It waits for the provider and the model's
  // reasoning (0.5-7 s measured for one prompt, #97), which no app change can bound;
  // the host's part of it is gated from host.log in the report (send to model request).
  const prompt = "What is 17 × 23? Reply with only the number.";
  const reply = "391";
  const repeat = Math.max(1, Number(process.env.PLAYBOOK_REPEAT ?? 5));
  const own = [], working = [], readable = [], ended = [], sendWait = [], newToReply = [], ownDriver = [], workingDriver = [];
  let freshOk = true;
  for (let i = 0; i < repeat; i++) {
    // From New session as the user sees it: nothing between the click and the
    // reply is left out. Send must be usable as soon as the composer is there
    // (Sun 11-18: new session to Send usable = 0 s); the wait is measured
    // without Playwright's own waiting for an enabled button.
    let clicked = now();
    if (i > 0) {
      clicked = now();
      await newSession().click();
      await composer().waitFor({ timeout: 10_000 });
    }
    await composer().fill(prompt);
    const typed = now();
    if (i > 0) {
      // 0 when Send is enabled at the first look; else how long it took.
      let waited = 0;
      while (!await send().isEnabled().catch(() => false)) {
        if (now() - typed > 60_000) { waited = 60_000; break; }
        await page.waitForTimeout(10);
        waited = now() - typed;
      }
      sendWait.push(waited);
    }
    await armVisibleTimer(prompt);
    start = now();
    await send().click();
    const ownSeen = waitForConversationText(prompt, 5_000).then(() => now() - start);
    const stopSeen = stop().waitFor({ timeout: 5_000 }).then(() => now() - start, () => null);
    ownDriver.push(await ownSeen);
    const stopMs = await stopSeen;
    await waitForConversationText(reply, 60_000);
    readable.push(now() - start);
    if (i > 0) newToReply.push(now() - clicked);
    // Turn end = Stop gone and Send enabled; no hint string is used.
    await stop().waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await send().waitFor({ timeout: 30_000 });
    ended.push(now() - start);
    const inPage = await readVisibleTimer();
    if (inPage.own == null) throw new Error("own message visible: the in-page timer saw no click or no message");
    own.push(inPage.own);
    // A reply faster than Stop could be seen shows the turn as done instead.
    working.push(inPage.stop ?? inPage.own);
    workingDriver.push(stopMs ?? readable[readable.length - 1]);
    freshOk &&= (await conversation().innerText()).includes(reply);
  }
  // 0 ms: a new session is sendable the moment its composer shows.
  if (sendWait.length) assertRepeatedGate("newSessionSendWait", sendWait, 0);
  if (newToReply.length) record("newSessionToReply", newToReply);
  assertRepeatedGate("ownMessageVisible", own, 100);
  assertRepeatedGate("workingVisible", working, 100);
  // The same two moments as the driver sees them (click() call to waitFor() resolving):
  // they add the driver's actionability checks, CDP round trips and polling backoff
  // (20, 50, 100 ms) and whatever else the machine runs. Recorded, never gated.
  record("ownMessageVisibleDriver", ownDriver);
  record("workingVisibleDriver", workingDriver);
  record("warmFirstReadable", readable);
  record("turnObservedEnd", ended);
  scenario("P0-1 fresh turn", freshOk, `${repeat} new sessions`);
  await page.screenshot({ path: process.env.TEMP + "\\playbook-01-chat.png" });

  // P0-2: second new session must not show the previous transcript.
  start = now();
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  await mark("secondNewSessionUsable", now() - start);
  const secondPrompt = "What is 19 × 21? Reply with only the number.";
  const secondReply = "399";
  await composer().fill(secondPrompt);
  await send().click();
  await waitForConversationText(secondReply);
  const secondText = await conversation().innerText();
  scenario("P0-2 second session", secondText.includes(secondReply) && !secondText.includes(prompt));
  await page.screenshot({ path: process.env.TEMP + "\\playbook-02-second.png" });

  // P0-3: reopen the first saved session by its visible prompt.
  start = now();
  await page.getByText(/What is 17 × 23/, { exact: false }).first().click();
  await waitForConversationText(reply);
  await mark("savedSessionSwitch", now() - start);
  assertGate("savedSessionSwitch", now() - start, 2_000);
  scenario("P0-3 reopen saved session", true);
  await imageSurvivesSessionSwitch("What is 17 × 23");

  // Image tool settings (#64, #67). Holds whatever the account can do: a
  // provider is offered only when it lists image models, otherwise the page says
  // why; the tab renders whether or not tools settings were ever saved.
  await page.getByRole("button", { name: C.settings, exact: true }).first().click();
  const settings = page.getByRole("dialog");
  await settings.getByRole("tab", { name: L.toolsTab, exact: true }).click();
  await settings.getByText(C.imageGeneration, { exact: true }).waitFor({ timeout: 10_000 });
  scenario("Tools tab opens without saved tools settings (#67)", true);
  const provider = settings.getByLabel(C.imageProvider, { exact: true });
  await page.waitForFunction(({ label, loading }) => !document.querySelector(`select[aria-label="${label}"]`)?.textContent?.includes(loading), { label: C.imageProvider, loading: C.loading }, { timeout: 25_000 });
  const offered = await provider.isEnabled();
  const modelText = await settings.getByLabel(C.imageModel, { exact: true }).inputValue();
  const reasons = settings.getByRole("list", { name: C.unavailableImageProviders });
  const failedChange = await settings.getByText(C.toolsChangeFailed).count();
  const usableProviderOk = offered
    ? modelText !== ""
    : (await provider.inputValue()) === "" && await reasons.isVisible();
  scenario(
    "Image provider offered only when usable, otherwise reason shown (#64)",
    usableProviderOk && failedChange === 0,
    offered ? `provider ${await provider.inputValue()}, model ${modelText}` : await reasons.innerText().catch(() => "no reason shown"),
  );
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-tools.png" });
  await page.keyboard.press("Escape");
  await shisaKeyWithoutRestart();
  await imageProviderScenario();

  // Reply language set in desktop Settings reaches the next new session.
  // Measures: the reply of a session opened after the change is written in the chosen
  // language. Why: the setting is Jouzu's own (shared with Jouzu in a terminal); the
  // desktop once had no way to see or change it. The previous value is restored after.
  const openLanguageSettings = async () => {
    await page.getByRole("button", { name: C.settings, exact: true }).click();
    await page.getByRole("tab", { name: L.general, exact: true }).click();
    return page.getByRole("combobox", { name: L.responseLanguage, exact: true });
  };
  let replyLanguage = await openLanguageSettings();
  const previousReplyLanguage = (await replyLanguage.innerText()).trim();
  await replyLanguage.click();
  await page.getByRole("option", { name: "日本語", exact: true }).click();
  await page.getByRole("combobox", { name: L.responseLanguage, exact: true }).filter({ hasText: "日本語" }).waitFor({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const languagePrompt = "Name one primary color, in one short sentence.";
  await composer().fill(languagePrompt);
  await send().click();
  await waitForConversationText(languagePrompt, 5_000);
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await send().waitFor({ timeout: 60_000 });
  const languageReply = (await conversation().innerText()).replace(languagePrompt, "");
  // What Desktop controls is what reaches the model: the session's language contract
  // and the response language line of its system prompt. Whether the model then
  // answers in that language is the model's behaviour, recorded but not judged.
  const languageEvidence = sessionLanguageEvidence(languagePrompt);
  if (languageEvidence === null) {
    result.scenarios.push({ name: "Reply language set in Settings applies to the next new session", ok: true, skipped: true, detail: "not run: PLAYBOOK_DATA_DIR is not set, so the session file cannot be read" });
  } else {
    scenario("Reply language set in Settings applies to the next new session", languageEvidence.contract && languageEvidence.prompt,
      `contract returnLanguage ja: ${languageEvidence.contract}; system prompt "Response language: Japanese (ja)": ${languageEvidence.prompt}; file: ${languageEvidence.file}; model replied: ${languageReply.slice(0, 120)}`);
  }
  await page.screenshot({ path: process.env.TEMP + "\\playbook-03-reply-language.png" });
  replyLanguage = await openLanguageSettings();
  await replyLanguage.click();
  await page.getByRole("option", { name: previousReplyLanguage, exact: true }).click();
  await page.keyboard.press("Escape");

  await webAccessScenario();
} catch (error) {
  // The single-scenario mode ends the flow early on purpose; that is not a failure.
  if (!error?.done) {
    result.errors.push(String(error?.stack ?? error));
    await page.screenshot({ path: process.env.TEMP + "\\playbook-failure.png" }).catch(() => {});
  }
}

result.pass = result.errors.length === 0
  && Object.values(result.gates).every(gate => gate.ok)
  && result.scenarios.every(item => item.ok);
result.finishedAt = new Date().toISOString();
const text = JSON.stringify(result, null, 2);
console.log(text);
if (out) await (await import("node:fs/promises")).writeFile(out, text);
await browser.close();
process.exitCode = result.pass ? 0 : 1;
