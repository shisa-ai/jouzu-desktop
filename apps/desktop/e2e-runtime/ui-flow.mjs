// Drives the real desktop UI over CDP against a loopback provider.
// Requires: app running with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223,
// a configured provider pointing at the fixture port, and that fixture server running.
import { writeFile } from 'node:fs/promises';

const cdp = process.env.JOUZU_UI_CDP ?? 'http://127.0.0.1:9223';
const list = await (await fetch(`${cdp}/json/list`)).json();
const target = list.find(item => item.type === 'page' && item.url.includes('localhost:1420'));
if (!target) { console.error(`no app page at ${cdp}`); process.exit(2); }
const socket = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  }
};
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const text = () => evaluate('document.body.innerText');
const alerts = () => evaluate(`JSON.stringify([...document.querySelectorAll('[role="alert"]')].map(node => node.innerText))`);
const setDraft = value => evaluate(`(() => {
  const area = document.querySelector('textarea[aria-label="Message Jouzu"]');
  if (!area) return 'missing';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, ${JSON.stringify(value)});
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return area.value;
})()`);
const clickSubmit = () => evaluate(`(() => { const button = [...document.querySelectorAll('button[type="submit"]')].find(item => /Send|Steer/.test(item.innerText)); if (!button) return 'missing'; button.click(); return button.innerText; })()`);
const clickButton = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.innerText.trim() === ${JSON.stringify(label)}); if (!button) return 'missing'; button.click(); return 'clicked'; })()`);
const waitFor = async (predicate, milliseconds, label) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(250);
  }
  throw new Error(`timeout: ${label}`);
};
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); return ok; };
try {
  await waitFor(async () => (await text()).includes('Connected'), 180_000, 'chat connected');
  check('prewarmed chat without a workspace click', true);
  await clickButton('New session');
  await waitFor(async () => (await evaluate(`document.querySelectorAll('article').length`)) === 0, 30_000, 'clean session');

  await evaluate(`document.querySelector('button[aria-label="Model"]')?.click()`);
  await sleep(800);
  const models = await evaluate(`JSON.stringify([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.innerText))`);
  check('model catalog visible', models.includes('deterministic'), models);
  await evaluate(`(() => { const button = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.innerText.includes('deterministic')); button?.click(); return !!button; })()`);
  await sleep(500);
  check('model selected', (await evaluate(`document.querySelector('button[aria-label="Model"]')?.innerText`)).includes('deterministic'));

  await setDraft('TEXT ui harness');
  check('prompt submitted', (await clickSubmit()) === 'Send');
  await waitFor(async () => (await text()).includes('fixture reply'), 90_000, 'reply');
  check('prompt reply rendered', (await text()).includes('TEXT ui harness'));

  await setDraft('TOOL ui harness');
  await clickSubmit();
  await waitFor(async () => (await text()).includes('tool finished'), 90_000, 'tool continuation');
  const toolCard = await evaluate(`!!document.querySelector('summary')?.innerText?.includes('read')`);
  check('tool card rendered', toolCard);

  await setDraft('SLOW ui harness');
  await clickSubmit();
  await waitFor(async () => (await text()).includes('waiting-for-steer'), 90_000, 'slow start');
  check('running state exposes steer and stop', (await text()).includes('Steer') && (await text()).includes('Stop'));
  await setDraft('STEER ui harness');
  check('steer submitted while running', (await clickSubmit()) === 'Steer');
  await waitFor(async () => (await text()).includes('slow finished'), 90_000, 'slow finish');
  await waitFor(async () => (await text()).includes('Enter to send'), 90_000, 'steer settled');

  await setDraft('ABORT ui harness');
  await clickSubmit();
  await waitFor(async () => (await text()).includes('waiting-for-abort'), 90_000, 'abort start');
  check('stop clicked', (await clickButton('Stop')) === 'clicked');
  await waitFor(async () => (await alerts()).includes('aborted'), 90_000, 'aborted state');
  check('abort reported by the runtime', (await alerts()).includes('aborted'));

  check('new chat clicked', (await clickButton('New session')) === 'clicked');
  await waitFor(async () => (await evaluate(`document.querySelectorAll('article').length`)) === 0, 30_000, 'new chat empty');
  await setDraft('after new chat');
  await clickSubmit();
  await waitFor(async () => (await text()).includes('after new chat') && (await text()).includes('fixture reply'), 90_000, 'post-new reply');
  check('session continues after new chat', true);

  const currentAlerts = await alerts();
  check('no unsupported disposition error', !currentAlerts.includes('unsupported'), currentAlerts);
} catch (error) {
  results.push({ name: 'sequence', ok: false, detail: String(error) });
}
const failures = results.filter(result => !result.ok);
await writeFile(new URL('./ui-flow-result.json', import.meta.url), JSON.stringify({ results, failures, alerts: await alerts() }, null, 2));
console.log(JSON.stringify({ results, failures }, null, 2));
socket.close();
process.exit(failures.length ? 1 : 0);
