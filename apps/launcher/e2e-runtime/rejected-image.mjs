import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { hostAccess } from './host-access.mjs';

// Regression check for #17: a session whose history holds an image the model refuses
// can continue after "Remove images", and is never left hanging.
// Against a running host on a throwaway home (JOUZU_E2E_HOST_HOME: the host's --home,
// fixture provider, fixture server running) with one workspace, JOUZU_E2E_WORKSPACE:
//   1. the model reads a 256x1 PNG with the read tool; the fixture provider refuses
//      the next request with the provider text from #17;
//   2. the refusal is shown above the composer with "Remove images" and "New session";
//   3. a second message fails the same way (the runtime sends the image again,
//      shisa-ai/jouzu#54), and the composer is usable again afterwards;
//   4. "Remove images" takes the image out of the history; the next message gets a reply.
// It never touches the user's data folder or contacts a real provider.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
const workspace = process.env.JOUZU_E2E_WORKSPACE;
if (!hostHome || !workspace) {
  console.error('JOUZU_E2E_HOST_HOME and JOUZU_E2E_WORKSPACE must be set; skipping.');
  process.exit(2);
}

function png(width, height) {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc = buffer => {
    let value = 0xffffffff;
    for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const image = `rejected-${Date.now()}.png`;
writeFileSync(join(workspace, image), png(256, 1));

const host = hostAccess(hostHome);
const base = `http://127.0.0.1:${host.port}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.addInitScript(([url, token]) => { window.__JOUZU_HOST__ = { baseUrl: url, token }; localStorage.setItem('jouzu.ui.language', 'en'); }, [base, host.token]);
const page = await context.newPage();
const composer = () => page.getByRole('textbox', { name: /message/i }).first();
const send = () => page.getByRole('button', { name: /^send$/i }).first();
const refusal = () => page.getByText('The model rejected a request because of an image in this conversation.', { exact: false }).first();
const removeImages = () => page.getByRole('button', { name: 'Remove images' }).first();
const submit = async text => {
  await composer().fill(text);
  await send().click();
};

await page.goto(base);
await page.getByText('Connecting to Jouzu…').first().waitFor({ state: 'detached', timeout: 60_000 });
await page.getByRole('button', { name: /new session/i }).first().click();
const folder = workspace.split(/[\\/]/u).filter(Boolean).at(-1);
await page.getByRole('button', { name: 'Choose workspace' }).click();
await page.getByRole('menuitemradio').filter({ hasText: folder }).first().click();
await page.getByRole('button', { name: 'Choose workspace' }).filter({ hasText: folder }).waitFor({ timeout: 30_000 });
await composer().waitFor({ timeout: 30_000 });

await submit(`TOOL:${image} please look at this image`);
let shown = await refusal().waitFor({ timeout: 60_000 }).then(() => true, () => false);
check('The refusal is shown above the composer', shown, shown ? 'shown' : 'no refusal notice within 60 s');
check('It offers Remove images and New session', shown && await removeImages().isVisible() && await page.getByRole('button', { name: 'New session' }).last().isVisible(), '');

await send().waitFor({ timeout: 30_000 });
await submit('hello again');
await page.waitForTimeout(1_000);
await send().waitFor({ timeout: 60_000 });
shown = await refusal().isVisible();
check('Without the repair the next message fails the same way, and the composer is usable again', shown, shown ? 'refused again' : 'not refused');
await page.screenshot({ path: join(tmpdir(), 'rejected-image-refused.png') });

await removeImages().click();
const removed = await page.getByText(/Removed 1 image from this conversation/).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
check('Remove images takes the image out of the history', removed, removed ? 'removed 1' : 'no confirmation within 30 s');
await page.waitForTimeout(1_500);
await submit('after the repair');
const replied = await page.getByText('tool finished').last().waitFor({ timeout: 60_000 }).then(() => true, () => false);
await send().waitFor({ timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(1_000);
const stillRefused = await refusal().isVisible();
check('After the repair the next message gets a reply', replied && !stillRefused, replied ? (stillRefused ? 'reply, but the refusal is still shown' : 'reply') : 'no reply within 60 s');
await page.screenshot({ path: join(tmpdir(), 'rejected-image-repaired.png') });
await browser.close();

writeFileSync('rejected-image-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
