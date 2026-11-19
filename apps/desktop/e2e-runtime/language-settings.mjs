import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';

// Regression check for "desktop language settings match the jouzu CLI's".
// Against an official extracted setup (JOUZU_E2E_RUNTIME), in a throwaway JOUZU_HOME:
//   1. the desktop saves reply/artifact language through its control adapter, and a new
//      runtime's system prompt carries exactly those instructions;
//   2. a change made the way Jouzu's own Settings saves it is what the desktop reads,
//      and what the next runtime uses.
// It never touches the user's data folder or contacts a real provider.
const runtime = process.env.JOUZU_E2E_RUNTIME;
if (!runtime) {
  console.error('JOUZU_E2E_RUNTIME is not set; skipping the language settings check.');
  process.exit(2);
}
const node = join(runtime, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const app = join(runtime, 'app');
const control = join(import.meta.dirname, '..', '..', '..', 'packaging', 'desktop', 'control.mjs');
const home = mkdtempSync(join(tmpdir(), 'jouzu-language-'));
const env = { ...process.env, JOUZU_HOME: home, JOUZU_NO_UPDATE: '1', PI_SKIP_VERSION_CHECK: '1' };
delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.JOUZU_UI_LOCALE;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

function run(args, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(input);
  });
}
const desktop = async request => JSON.parse(await run([control, runtime, app], JSON.stringify(request)));

/** One prompt in a fresh runtime; returns the system prompt the provider received. */
async function systemPromptOfNewSession() {
  const server = await startFixtureServer(0);
  const child = spawn(node, [join(app, 'bootstrap.mjs'), '--mode', 'rpc', '-e', join(import.meta.dirname, 'matrix-provider.mjs')], {
    cwd: home, env: { ...env, MATRIX_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let buffer = '';
  let settled = false;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(index + 1)) {
      try { if (JSON.parse(buffer.slice(0, index)).type === 'agent_settled') settled = true; } catch { /* not an event */ }
    }
  });
  child.stdin.write(JSON.stringify({ type: 'set_model', id: 'm', provider: 'matrix-fixture', modelId: 'deterministic' }) + '\n');
  child.stdin.write(JSON.stringify({ type: 'prompt', id: 'p', message: 'LANGUAGE check' }) + '\n');
  const deadline = Date.now() + 120_000;
  while (!settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  child.kill();
  server.server.close();
  return server.requests.find(request => request.text.includes('LANGUAGE check'))?.system ?? null;
}

try {
  const before = await desktop({ action: 'status' });
  check('fresh home: reply language automatic, artifact policy Jouzu default',
    before.language?.status === 'absent' && before.language.responseLanguage.effective === 'auto' && before.language.artifactPolicy.effective.comments === 'preserve',
    before.language ?? before.error);

  const english = { comments: 'en', documentation: 'en', commits: 'en', reviews: 'en' };
  const saved = await desktop({ action: 'language', responseLanguage: 'ja', artifactPolicy: english, uiLocale: 'ja' });
  check('desktop save is reported back as saved settings',
    saved.language?.responseLanguage.source === 'config' && saved.language.responseLanguage.effective === 'ja' && saved.language.artifactPolicy.effective.commits === 'en' && saved.language.uiLocale.requested === 'ja',
    saved.language ?? saved.error);
  const file = JSON.parse(readFileSync(join(home, 'localization.json'), 'utf8'));
  check('desktop save writes Jouzu\'s own file format',
    file.schemaVersion === 2 && file.localization?.responseLanguage === 'ja' && file.localization?.uiLocale === 'ja' && file.localization?.artifactPolicy?.reviews === 'en', file);

  const system = await systemPromptOfNewSession();
  check('new session after a desktop save: runtime instructs Japanese replies', system?.includes('Response language: Japanese (ja)'), system?.slice(0, 400));
  check('new session after a desktop save: runtime instructs English commits', system?.includes('- commits: Use English (en).'), null);

  // The jouzu side: the same call Jouzu's terminal Settings makes.
  const jouzu = name => import(pathToFileURL(join(app, 'node_modules', 'jouzu', 'dist', `${name}.js`)));
  const { applyLocalization } = await jouzu('localization-ops');
  const { resolveJouzuPaths } = await jouzu('paths');
  applyLocalization(resolveJouzuPaths({ homeOverride: home }), { sessionId: 'settings', scope: 'environment', request: { responseLanguage: 'zh-Hant', uiLocale: 'en' } });
  const read = await desktop({ action: 'status' });
  check('a change saved by Jouzu\'s Settings is what the desktop reads',
    read.language?.responseLanguage.effective === 'zh-Hant' && read.language.uiLocale.requested === 'en' && read.language.uiLocale.source === 'config' && read.language.artifactPolicy.effective.commits === 'en',
    read.language ?? read.error);
  const next = await systemPromptOfNewSession();
  check('next session uses the Jouzu-side change', next?.includes('Response language: Traditional Chinese (zh-Hant)'), next?.slice(0, 400));

  const rejected = await desktop({ action: 'language', responseLanguage: 'fr' });
  check('an unsupported value is refused and nothing is overwritten',
    !!rejected.error && JSON.parse(readFileSync(join(home, 'localization.json'), 'utf8')).localization.responseLanguage === 'zh-Hant', rejected.error);
} catch (error) {
  check('run', false, String(error?.stack ?? error));
}
const failed = results.filter(result => !result.ok);
const out = process.env.LANGUAGE_RESULT ?? join(import.meta.dirname, 'language-settings-result.json');
writeFileSync(out, JSON.stringify({ home, results }, null, 2));
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
process.exit(failed.length ? 1 : 0);
