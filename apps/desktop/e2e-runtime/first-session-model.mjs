import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostAccess } from './host-access.mjs';

// Regression check for #99: the first new session after the host starts shows a
// model and takes a message at once. Its model is the one its runtime reports;
// until the runtime answers, the host shows the runtimes' earlier answer, and a
// message sent meanwhile waits for the model instead of being refused.
// Against a host JUST started on a throwaway home (JOUZU_E2E_HOST_HOME: the host's
// --home, with a usable default model). Never touches the user's data folder.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
const workspace = process.env.JOUZU_E2E_WORKSPACE;
if (!hostHome || !workspace) {
  console.error('JOUZU_E2E_HOST_HOME or JOUZU_E2E_WORKSPACE is not set; skipping the first session model check.');
  process.exit(2);
}
const host = hostAccess(hostHome);
const base = `http://127.0.0.1:${host.port}`;
const headers = { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' };
const call = async (path, body) => {
  const response = await fetch(base + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
};
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const created = await call('/v1/sessions', { workspacePath: workspace });
const atCreate = created.model?.state ?? 'none';
// Sent the moment the session exists: accepted, never refused for a model on its way.
const sent = await fetch(`${base}/v1/sessions/${created.sessionId}/messages`, {
  method: 'POST', headers, body: JSON.stringify({ clientMessageId: `first-${Date.now()}`, text: 'Reply with only the word ok.' }),
});
check('a message sent at once is accepted', sent.ok, `status ${sent.status}`);
let model = created.model ?? {};
for (let attempt = 0; attempt < 20 && model.state === 'resolving'; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 250));
  model = (await call(`/v1/sessions/${created.sessionId}`)).model ?? {};
}
check(
  'a new session shows the model its runtime reports',
  model.state === 'ready' && model.provider && model.id,
  `at create: ${atCreate} | now: ${model.state ?? 'none'} ${model.provider ?? ''}/${model.id ?? ''}`,
);

writeFileSync('first-session-model-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
