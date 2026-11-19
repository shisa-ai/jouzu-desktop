import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startFixtureServer } from './fixture-server.mjs';

// Real released-runtime RPC matrix. Requires JOUZU_E2E_RUNTIME to point at an
// extracted official setup; it never installs, patches, or contacts a paid provider.
const runtime = process.env.JOUZU_E2E_RUNTIME;
if (!runtime) {
  console.error('JOUZU_E2E_RUNTIME is not set; skipping the released-runtime matrix.');
  process.exit(2);
}
const home = process.env.JOUZU_E2E_HOME ?? join(runtime, '..', 'matrix-home');
const server = await startFixtureServer(0);
const baseUrl = `http://127.0.0.1:${server.port}/v1`;
const env = {
  ...process.env,
  JOUZU_HOME: home,
  JOUZU_NO_UPDATE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  MATRIX_BASE_URL: baseUrl,
};
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const child = spawn(join(runtime, 'runtime/node/node.exe'), [join(runtime, 'app/bootstrap.mjs'), '--mode', 'rpc', '-e', join(import.meta.dirname, 'matrix-provider.mjs')], {
  cwd: process.env.JOUZU_E2E_WORKSPACE ?? process.cwd(),
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const events = [];
const responses = new Map();
let output = '';
const failures = [];
let requestId = 0;
const record = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); return { name, ok, detail }; };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const timeout = (promise, milliseconds, label) => Promise.race([promise, sleep(milliseconds).then(() => { throw new Error(`timeout: ${label}`); })]);
const waitFor = async (predicate, milliseconds, label) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
};
const send = (command, fields = {}) => {
  const id = `matrix-${++requestId}`;
  const response = new Promise((resolve, reject) => responses.set(id, { resolve, reject }));
  child.stdin.write(JSON.stringify({ ...fields, type: command, id }) + '\n');
  return timeout(response, 120_000, `${command} response`);
};
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
child.stdout.on('data', chunk => {
  output += chunk;
  let index;
  while ((index = output.indexOf('\n')) >= 0) {
    const line = output.slice(0, index); output = output.slice(index + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'response' && event.id && responses.has(event.id)) {
      const pending = responses.get(event.id); responses.delete(event.id);
      if (event.success) pending.resolve(event); else pending.reject(new Error(event.error ?? 'runtime command failed'));
    } else if (event.type !== 'response') events.push(event);
  }
});
const exit = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('') : '';
const results = [];
try {
  const state = await send('get_state');
  results.push(record('get_state', typeof state.data?.sessionId === 'string', state.data?.sessionId));
  const firstSession = state.data.sessionFile;
  const firstId = state.data.sessionId;

  await send('prompt', { message: 'TEXT matrix' });
  const textEvent = await waitFor(event => event.type === 'message_update' && event.assistantMessageEvent?.delta?.includes('fixture reply'), 60_000, 'text stream');
  await waitFor(event => event.type === 'agent_settled', 60_000, 'text settled');
  results.push(record('prompt text', textEvent.assistantMessageEvent.delta.includes('fixture reply'), textEvent.assistantMessageEvent.delta));

  await send('prompt', { message: 'SLOW matrix' });
  await waitFor(event => event.type === 'message_update' && event.assistantMessageEvent?.delta === 'waiting-for-steer', 60_000, 'slow start');
  await send('steer', { message: 'STEER matrix' });
  await waitFor(event => event.type === 'message_update' && event.assistantMessageEvent?.delta === 'slow finished', 60_000, 'slow finish');
  await waitFor(event => event.type === 'agent_settled', 60_000, 'slow settled');
  let steerRequest;
  for (let attempt = 0; attempt < 100 && !steerRequest; attempt++) {
    steerRequest = server.requests.find(request => request.text.includes('STEER matrix'));
    if (!steerRequest) await sleep(100);
  }
  results.push(record('steer delivered', !!steerRequest, steerRequest?.text));

  await send('prompt', { message: 'ABORT matrix' });
  await waitFor(event => event.type === 'message_update' && event.assistantMessageEvent?.delta === 'waiting-for-abort', 60_000, 'abort start');
  await send('abort');
  const aborted = await waitFor(event => event.type === 'message_end' && event.message?.stopReason === 'aborted', 60_000, 'aborted message');
  results.push(record('abort', aborted.message.stopReason === 'aborted', aborted.message.stopReason));
  await waitFor(event => event.type === 'agent_settled', 60_000, 'abort settled');

  const cleared = await send('clear_queue');
  results.push(record('clear_queue', cleared.success === true, undefined));

  const created = await send('new_session');
  results.push(record('new_session', created.data?.cancelled === false, created.data?.cancelled));
  const newState = await send('get_state');
  results.push(record('new session id', newState.data?.sessionId !== firstId, newState.data?.sessionId));
  const emptyHistory = await send('get_messages');
  results.push(record('new history empty', Array.isArray(emptyHistory.data?.messages) && emptyHistory.data.messages.length === 0, emptyHistory.data?.messages?.length));

  const switched = await send('switch_session', { sessionPath: firstSession });
  results.push(record('switch_session', switched.data?.cancelled === false, switched.data?.cancelled));
  const restored = await send('get_state');
  const restoredHistory = await send('get_messages');
  results.push(record('history restored', restored.data?.sessionId === firstId && restoredHistory.data?.messages?.length > 0, { id: restored.data?.sessionId, messages: restoredHistory.data?.messages?.length }));

  const models = await send('get_available_models');
  const available = models.data?.models ?? [];
  results.push(record('model catalog', available.some(model => model.provider === 'matrix-fixture' && model.id === 'deterministic'), available.length));
  const selected = await send('set_model', { provider: 'matrix-fixture', modelId: 'deterministic' });
  results.push(record('set_model', selected.success === true, selected.data?.name));

  let compacted;
  try { compacted = await send('compact'); }
  catch (error) { compacted = { error: String(error) }; }
  results.push(record('compact', compacted.success === true || String(compacted.error).includes('Nothing to compact'), compacted.data ?? compacted.error));
  const exportPath = join(tmpdir(), `jouzu-rpc-matrix-${Date.now()}.html`);
  const exported = await send('export_html', { outputPath: exportPath });
  results.push(record('export_html', exported.success === true && existsSync(exportPath) && statSync(exportPath).size > 0, { path: exportPath, size: existsSync(exportPath) ? statSync(exportPath).size : 0 }));
} catch (error) {
  failures.push({ name: 'sequence', detail: String(error) });
}
child.stdin.end();
const closed = await exit;
results.push(record('clean exit', closed.code === 0, closed));
server.server.closeAllConnections(); server.server.close();
await writeFile(join(import.meta.dirname, 'rpc-matrix-result.json'), JSON.stringify({ results, failures, requests: server.requests, events: events.slice(-80), stderr }, null, 2));
console.log(JSON.stringify({ results, failures, requests: server.requests, events: events.slice(-20), stderr }, null, 2));
process.exit(failures.length ? 1 : 0);
