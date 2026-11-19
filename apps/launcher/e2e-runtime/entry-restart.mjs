import { chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostAccess } from './host-access.mjs';

// Regression check for #73: the startup loader must end even when a catalog revision
// activated at startup restarts the chat while its first session lease is still
// waiting for a runtime (the first start after an update).
// Against a running host on a throwaway home (JOUZU_E2E_HOST_HOME: the host's --home,
// model-ready with the fixture provider, fixture server running):
//   1. open a new session and send one message, so the workspace has an entry session;
//   2. reopen with the same browser profile. The first lease is held 4 s. The loader
//      must be gone and the entry session open. (A catalog revision activated at
//      startup used to restart the chat here; configuration changes no longer
//      restart sessions, so only the held lease remains of that order.)
// It never touches the user's data folder or contacts a real provider.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
if (!hostHome) {
  console.error('JOUZU_E2E_HOST_HOME is not set; skipping the entry restart check.');
  process.exit(2);
}
const host = hostAccess(hostHome);
const base = `http://127.0.0.1:${host.port}`;
const profile = mkdtempSync(join(tmpdir(), 'jouzu-entry-restart-'));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

async function open() {
  const context = await chromium.launchPersistentContext(profile, {});
  const page = context.pages()[0] ?? await context.newPage();
  await page.addInitScript(([url, token]) => {
    window.__JOUZU_HOST__ = { baseUrl: url, token };
    localStorage.setItem('jouzu.ui.language', 'en');
  }, [base, host.token]);
  return { context, page };
}

// 1. An entry session with a transcript.
{
  const { context, page } = await open();
  await page.goto(base);
  await page.getByText('Connecting to Jouzu…').first().waitFor({ state: 'detached', timeout: 60_000 });
  // As a person does: New session (clickable once the start-up screen is gone), then
  // type. Typing behind the start-up screen went into a composer that was replaced.
  await page.getByRole('button', { name: 'New session', exact: true }).first().click({ timeout: 120_000 });
  await page.getByRole('textbox', { name: /message/i }).first().fill('Reply with OK.');
  await page.getByRole('button', { name: /^send$/i }).first().click({ timeout: 30_000 });
  await page.getByRole('button', { name: /^send$/i }).first().waitFor({ timeout: 60_000 });
  await context.close();
}

// 2. Restart during the entry open.
{
  const { context, page } = await open();
  const opened = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/sessions')) opened.push(request.postDataJSON()?.sessionPath ?? null);
  });
  let held = false;
  await page.route('**/v1/sessions', async route => {
    if (!held && route.request().method() === 'POST') { held = true; await new Promise(resolve => setTimeout(resolve, 4_000)); }
    await route.fallback();
  });
  await page.goto(base);
  await page.waitForTimeout(15_000);
  const loader = await page.getByText('Connecting to Jouzu…').count();
  check('loader ends after a startup restart during the entry open', loader === 0, `loader elements: ${loader}`);
  check('the entry session was opened', opened.some(path => typeof path === 'string'), JSON.stringify(opened));
  await page.screenshot({ path: join(tmpdir(), 'entry-restart.png') });
  await context.close();
}

writeFileSync('entry-restart-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
