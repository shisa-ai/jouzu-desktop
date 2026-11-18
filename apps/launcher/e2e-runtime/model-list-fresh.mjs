import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression check for #84: the model list follows settings changes.
// Against a running host on a throwaway home (JOUZU_E2E_HOST_HOME: the host's --home,
// with at least one usable model): list the models, add a provider through Settings
// and save its key, list again: it must be listed without restarting anything; remove
// its key, list again: it must be gone. It never touches the user's data folder or contacts a provider.
const hostHome = process.env.JOUZU_E2E_HOST_HOME;
if (!hostHome) {
  console.error('JOUZU_E2E_HOST_HOME is not set; skipping the model list check.');
  process.exit(2);
}
const host = JSON.parse(readFileSync(join(hostHome, 'host.json'), 'utf8'));
const base = `http://127.0.0.1:${host.port}`;
const headers = { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' };
const call = async (path, body) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(base + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const json = await response.json();
    // A settings change restarts the warm runtime; its list is read once it answers.
    if (json?.error?.code === 'models-unavailable') { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  }
  throw new Error(`${path}: still busy`);
};
// A configuration operation is queued by the host; its result arrives in the app snapshot.
const configure = async (kind, body) => {
  const { operationId } = await call(`/v1/config/${kind}`, body);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const result = (await call('/v1/app')).config.lastResult[kind];
    if (result?.operationId === operationId) {
      if (!result.ok) throw new Error(`${kind}: ${JSON.stringify(result)}`);
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${kind}: no result`);
};
const providers = list => [...new Set(list.models.map(model => model.provider))].sort();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

const id = `added-${Date.now().toString(36)}`;
const before = providers(await call('/v1/models'));
await configure('custom-provider', { provider: id, url: 'http://127.0.0.1:43123/v1', model: 'deterministic' });
await configure('provider-key', { provider: id, token: 'fixture-key' });
const after = providers(await call('/v1/models'));
check('a provider added in Settings is listed at once', after.includes(id), `before: ${before.join(', ')} | after: ${after.join(', ')}`);
// Removing its key takes it off the list again (the signed-out case).
await configure('provider-remove', { provider: id });
const removed = providers(await call('/v1/models'));
check('a provider whose key was removed leaves the list at once', !removed.includes(id), `after removal: ${removed.join(', ')}`);

writeFileSync('model-list-fresh-result.json', `${JSON.stringify({ results }, null, 2)}\n`);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
process.exit(results.every(result => result.ok) ? 0 : 1);
