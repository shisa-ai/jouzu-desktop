import { chromium } from "@playwright/test";

/**
 * Black-box user playbook. It uses accessible actions, visible text and a unique
 * reply sentinel only. It never reads host logs, endpoints, DOM structure or
 * layout. UI changes may require updating only the semantic locators below.
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

page.on("pageerror", error => result.errors.push(String(error)));
page.on("console", message => {
  if (message.type() === "error" && !/Failed to load resource/.test(message.text())) result.errors.push(message.text());
});

const newSession = () => page.getByRole("button", { name: /new session/i }).first();
const composer = () => page.getByRole("textbox", { name: /message/i }).first();
const send = () => page.getByRole("button", { name: /^send$/i }).first();
const stop = () => page.getByRole("button", { name: /^stop$/i }).first();
const conversation = () => page.getByRole("region", { name: /conversation/i }).first();

async function waitForConversationText(text, timeout = 30_000) {
  await conversation().getByText(text, { exact: true }).first().waitFor({ timeout });
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
  const chooser = page.getByLabel("Choose images", { exact: true });
  if (!await chooser.count()) {
    result.scenarios.push({ name, ok: true, skipped: true, detail: "the selected model takes no images" });
    return;
  }
  const imagePrompt = "What color is this square? Reply with one word.";
  await chooser.setInputFiles({ name: "red-square.png", mimeType: "image/png", buffer: await redSquarePng() });
  await page.getByRole("list", { name: "Attached images" }).waitFor({ timeout: 10_000 });
  await composer().fill(imagePrompt);
  await send().click();
  await waitForConversationText(imagePrompt, 5_000);
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 60_000 });
  const sentImage = () => conversation().getByRole("img", { name: "Conversation attachment" }).first();
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
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: /tools|ツール/i }).click();
    await dialog.getByText("Image generation", { exact: true }).waitFor({ timeout: 10_000 });
    return dialog;
  };
  const closeSettings = () => page.keyboard.press("Escape");
  let dialog = await openTools();
  const provider = dialog.getByLabel("Image provider");
  const model = dialog.getByLabel("Image model");
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
  const visitor = await chromium.launch();
  const openWebAccess = async () => {
    await openSettingsTab("Web access");
    return settingsDialog();
  };
  const choose = async (dialog, option) => {
    await dialog.getByRole("combobox", { name: "Who can connect" }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  const save = async dialog => {
    const button = dialog.getByRole("button", { name: "Save", exact: true });
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
    await choose(dialog, "This computer and trusted networks");
    const lan = dialog.getByRole("switch").first();
    const hasNetwork = await lan.count() > 0;
    if (hasNetwork) {
      if ((await lan.getAttribute("aria-checked")) !== "true") await lan.click();
    } else {
      await choose(dialog, "This computer only");
    }
    await save(dialog);
    await dialog.getByText(/Serving at:/).waitFor({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Pair a device" }).click();
    const links = await dialog.getByRole("textbox").evaluateAll(nodes => nodes.map(node => node.value).filter(value => value.includes("/pair?code=")));
    const local = links.find(url => url.startsWith("http://127.0.0.1:"));
    const network = links.find(url => !url.startsWith("http://127.0.0.1:"));
    // With the network on, the pairing links may name only network addresses; this
    // computer's address is the one "Serving at" lists.
    const serving = await dialog.getByText(/Serving at:/).innerText();
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
    await dialog.getByRole("button", { name: /^Remove / }).first().click();
    await dialog.getByText("No device is paired yet.").waitFor({ timeout: 10_000 });
    await paired.tab.reload();
    await paired.tab.waitForTimeout(1_000);
    scenario("Web access: a removed device is sent back to pairing (#91)", paired.tab.url().endsWith("/pair"), paired.tab.url());
    await paired.context.close();

    // Off: the port closes.
    await choose(dialog, "Off");
    await save(dialog);
    await dialog.getByText("Browsers and other devices cannot connect.").waitFor({ timeout: 10_000 });
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
  const earlier = () => conversation().getByRole("button", { name: /^(Show \d+ earlier messages?|Load earlier messages)$/ }).first();
  let clicks = 0;
  while (await earlier().isVisible().catch(() => false)) {
    await earlier().click();
    clicks += 1;
    await conversation().getByRole("button", { name: /Loading earlier messages/ }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
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
  await conversation().getByRole("button", { name: "Branch into a new conversation" }).first().click();
  // The branch opens as its own conversation: turn 1 there, the long session's last turn gone.
  await page.waitForFunction(last => {
    const text = document.querySelector('[aria-label="Conversation"]')?.textContent ?? "";
    return /Long session question 1(?!\d)/.test(text) && !text.includes(`Long session answer ${last}`);
  }, turns, { timeout: 30_000 }).catch(() => {});
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
const alerts = () => page.getByRole("alert").filter({ hasNotText: /Flow control paused after an interrupt/i });
const queued = () => page.getByRole("region", { name: "Queued messages" });
const userCount = text => conversation().getByText(text, { exact: true }).count();
/** The composer's submit button: "Send" when idle, "Steer" while a reply runs. */
const submit = () => page.getByRole("button", { name: /^(send|steer)$/i }).first();
/** The reply has really started writing: the fixture's marker, or a line "3" of the count. */
async function replyWriting(timeout = 60_000) {
  await page.waitForFunction(prompt => {
    const region = document.querySelector('[aria-label="Conversation"], [aria-label="conversation"]');
    const text = (region?.textContent ?? document.body.innerText).replace(prompt, "");
    return /waiting-for-steer|\b3\b/.test(text);
  }, longPrompt, { timeout });
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
  await page.getByRole("button", { name: /model/i }).first().click();
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
    await page.getByLabel("Choose images", { exact: true }).setInputFiles({ name: "red-square.png", mimeType: "image/png", buffer: await redSquarePng() });
    await page.getByRole("list", { name: "Attached images" }).waitFor({ timeout: 10_000 });
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
  const resume = queued().getByRole("button", { name: "Continue", exact: true });
  if (await resume.count()) {
    await resume.click();
    // The continued message starts a turn of its own; it may also end before Stop is seen.
    await stop().waitFor({ timeout: 5_000 }).catch(() => {});
    await turnEnds();
  }
}

async function runOwnershipScenarios() {
  const images = async () => (await page.getByLabel("Choose images", { exact: true }).count()) > 0;

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

async function openSettingsTab(name) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await settingsDialog().getByRole("tab", { name }).click();
}
async function modelMenuItems() {
  await page.getByRole("button", { name: /model/i }).first().click();
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
  await openSettingsTab("Environment");
  await settingsDialog().getByRole("button", { name: "Add variable" }).click();
  await settingsDialog().getByRole("textbox", { name: "Name" }).last().fill("SHISA_API_KEY");
  await settingsDialog().getByLabel("Value").last().fill(key);
  const save = settingsDialog().getByRole("button", { name: "Save", exact: true });
  await save.click();
  await save.waitFor({ state: "visible" });
  await settingsDialog().getByRole("tab", { name: "Model providers" }).click();
  // The key alone counts as a Shisa.AI connection, so the refresh control appears.
  const refresh = settingsDialog().getByRole("button", { name: "Refresh models" });
  await refresh.waitFor({ timeout: 15_000 });
  await refresh.click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("Refresh models"));
    return button && !button.disabled;
  }, null, { timeout: 30_000 });
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
 * The first new session after the app starts (#99). It was created before the
 * model list was known and showed "Select model", and Send did nothing without
 * a reason. Runs before the reload below, so the host is as freshly started as
 * the user's. Pass: the session shows a model; with no model at all, Send says
 * why above the composer instead of doing nothing.
 */
async function firstSessionHasModel() {
  const name = "First new session after start has a model, or Send says why (#99)";
  await newSession().waitFor({ timeout: 30_000 });
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const modelButton = page.getByRole("button", { name: "Model", exact: true }).first();
  const shown = async () => !/^\s*select model\s*$/i.test(await modelButton.innerText().catch(() => ""));
  const end = now() + 15_000;
  while (now() < end && !await shown()) await page.waitForTimeout(100);
  if (await shown()) {
    scenario(name, true, `model shown: ${(await modelButton.innerText()).trim()}`);
    return;
  }
  // Nothing to send with: the press must be answered with the reason.
  await composer().fill("model check");
  await send().click();
  const reason = page.getByText(/Choose a model before sending|No model is available/).first();
  const explained = await reason.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  scenario(name, explained, explained ? "no model configured; Send explained why" : "no model shown and Send gave no reason");
  await composer().fill("");
}

try {
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
  await page.getByRole("button", { name: /model/i }).first().click();
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
  // Gated (the app's own work): own message visible, the turn visibly working (Stop).
  // Recorded only: the answer itself. It waits for the provider and the model's
  // reasoning (0.5-7 s measured for one prompt, #97), which no app change can bound;
  // the host's part of it is gated from host.log in the report (send to model request).
  const prompt = "What is 17 × 23? Reply with only the number.";
  const reply = "391";
  const repeat = Math.max(1, Number(process.env.PLAYBOOK_REPEAT ?? 5));
  const own = [], working = [], readable = [], ended = [];
  let freshOk = true;
  for (let i = 0; i < repeat; i++) {
    if (i > 0) {
      await newSession().click();
      await composer().waitFor({ timeout: 10_000 });
    }
    start = now();
    await composer().fill(prompt);
    await send().click();
    const ownSeen = waitForConversationText(prompt, 5_000).then(() => now() - start);
    const stopSeen = stop().waitFor({ timeout: 5_000 }).then(() => now() - start, () => null);
    own.push(await ownSeen);
    const stopMs = await stopSeen;
    await waitForConversationText(reply, 60_000);
    readable.push(now() - start);
    // Turn end = Stop gone and Send enabled; no hint string is used.
    await stop().waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 30_000 });
    ended.push(now() - start);
    // A reply faster than Stop could be seen shows the turn as done instead.
    working.push(stopMs ?? readable[readable.length - 1]);
    freshOk &&= (await conversation().innerText()).includes(reply);
  }
  assertRepeatedGate("ownMessageVisible", own, 100);
  assertRepeatedGate("workingVisible", working, 100);
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
  await page.getByRole("button", { name: /^settings$/i }).first().click();
  const settings = page.getByRole("dialog");
  await settings.getByRole("tab", { name: /^tools$/i }).click();
  await settings.getByText("Image generation", { exact: true }).waitFor({ timeout: 10_000 });
  scenario("Tools tab opens without saved tools settings (#67)", true);
  const provider = settings.getByLabel("Image provider", { exact: true });
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Image provider"]')?.textContent?.includes("Loading"), null, { timeout: 25_000 });
  const offered = await provider.isEnabled();
  const modelText = await settings.getByLabel("Image model", { exact: true }).inputValue();
  const reasons = settings.getByRole("list", { name: "Unavailable image providers" });
  const failedChange = await settings.getByText("This tools change did not complete.").count();
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Language", exact: true }).click();
    return page.getByRole("combobox", { name: /reply language/i });
  };
  let replyLanguage = await openLanguageSettings();
  const previousReplyLanguage = (await replyLanguage.innerText()).trim();
  await replyLanguage.click();
  await page.getByRole("option", { name: "日本語", exact: true }).click();
  await page.getByRole("combobox", { name: /reply language/i }).filter({ hasText: "日本語" }).waitFor({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await newSession().click();
  await composer().waitFor({ timeout: 10_000 });
  const languagePrompt = "Name one primary color, in one short sentence.";
  await composer().fill(languagePrompt);
  await send().click();
  await waitForConversationText(languagePrompt, 5_000);
  await stop().waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await page.getByRole("button", { name: /^send$/i }).waitFor({ timeout: 60_000 });
  const languageReply = (await conversation().innerText()).replace(languagePrompt, "");
  scenario("Reply language set in Settings applies to the next new session", /[\u3040-\u30ff]/.test(languageReply), languageReply.slice(0, 200));
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
