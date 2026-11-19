import { chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostAccess } from './host-access.mjs';

// Regression check for #79: the files a turn changed are shown only under the session
// that ran the turn, never under another session put on screen afterwards.
// Against a running host on a throwaway home (JOUZU_E2E_HOST_HOME: the host's --home,
// fixture provider, fixture server running) with two workspaces, JOUZU_E2E_WS_A and
// JOUZU_E2E_WS_B:
//   1. a turn in workspace B, so B has a saved session;
//   2. a turn in workspace A during which a file in A changes (outside any tool, as a
//      shell command or a database would); A's summary lists it;
//   3. B's session is opened from the sidebar: its summary must not list A's file.
// It never touches the user's data folder or contacts a real provider.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
const wsA = process.env.JOUZU_E2E_WS_A;
const wsB = process.env.JOUZU_E2E_WS_B;
if (!hostHome || !wsA || !wsB) {
  console.error('JOUZU_E2E_HOST_HOME, JOUZU_E2E_WS_A and JOUZU_E2E_WS_B must be set; skipping.');
  process.exit(2);
}
const host = hostAccess(hostHome);
const base = `http://127.0.0.1:${host.port}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };
const marker = `changed-in-a-${Date.now()}.txt`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.addInitScript(([url, token]) => { window.__JOUZU_HOST__ = { baseUrl: url, token }; localStorage.setItem('jouzu.ui.language', 'en'); }, [base, host.token]);
const page = await context.newPage();
const composer = () => page.getByRole('textbox', { name: /message/i }).first();
const send = () => page.getByRole('button', { name: /^send$/i }).first();
const turn = async (text, during) => {
  await composer().fill(text);
  await send().click();
  if (during) await during();
  await page.getByText(/fixture reply|slow finished/).last().waitFor({ timeout: 60_000 });
  await send().waitFor({ timeout: 60_000 });
};
const workspace = async name => {
  await page.getByRole('button', { name: 'Choose workspace' }).click();
  await page.getByRole('menuitemradio').filter({ hasText: name }).first().click();
  await page.getByRole('button', { name: 'Choose workspace' }).filter({ hasText: name }).waitFor({ timeout: 30_000 });
  await composer().waitFor({ timeout: 30_000 });
};
const nameOf = path => path.split(/[\/]/).filter(Boolean).at(-1);

await page.goto(base);
await page.getByText('Connecting to Jouzu…').first().waitFor({ state: 'detached', timeout: 60_000 });
await page.getByRole('button', { name: /new session/i }).first().click();
await workspace(nameOf(wsB));
await turn('Session in B.');
await page.getByRole('button', { name: /new session/i }).first().click();
await workspace(nameOf(wsA));
await turn('SLOW turn in A.', async () => {
  await page.waitForTimeout(1_200);
  writeFileSync(join(wsA, marker), 'written during the turn');
});
await page.waitForTimeout(2_000);
check("A's summary lists the file changed during its turn", (await page.locator('body').innerText()).includes(marker), marker);
await page.getByText('Session in B.').first().click();
await page.waitForTimeout(3_000);
const shown = await page.locator('body').innerText();
check("B's session does not show A's changed file", shown.includes('Session in B.') && !shown.includes(marker), shown.includes(marker) ? `${marker} shown under B` : 'not shown');
await page.screenshot({ path: join(tmpdir(), 'turn-files-session.png') });
await browser.close();

writeFileSync('turn-files-session-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
