// Private, JSON-only adapter to the installed Jouzu configuration implementation.
// Requests arrive through stdin, never command-line arguments containing secrets.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const root = process.argv[1]?.endsWith("control.mjs") ? process.argv[2] : process.argv[1];
const appRoot = process.argv[1]?.endsWith('control.mjs') ? (process.argv[3] || join(root, 'app')) : (process.argv[2] || join(root, 'app'));
const load = name => import(pathToFileURL(join(appRoot, 'node_modules/jouzu/dist', `${name}.js`)));
let action = "status";
// Remote revocation is advisory: a saved sign-out still clears local credentials.
let signOutRevocation;
// A held catalog revision is a decision, not an error, and "nothing to refresh"
// is a different answer from "the refresh failed". Both travel with the state so
// the desktop can show its own confirmation instead of a generic failure.
let catalog = null;
const catalogOutcome = result => {
  if (!result) return { status: 'unconfigured', sources: [], held: null };
  const results = result.results ?? [];
  const sources = results.map(({ source, result: each }) => ({ sourceId: source?.id ?? '', status: each?.status ?? 'unknown' }));
  const held = results.find(({ result: each }) => each?.status === 'quarantined');
  return {
    status: held ? 'quarantined' : (result.status ?? 'unknown'),
    sources,
    held: held ? {
      sourceId: held.source?.id ?? '',
      revision: String(held.result.revision ?? ''),
      digest: String(held.result.digest ?? ''),
      reasons: Array.isArray(held.result.reasons) ? held.result.reasons.map(String) : [],
      changes: held.result.changes ?? null,
    } : null,
  };
};
try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  action = request.action;
  const { resolveJouzuPaths } = await load('paths');
  const paths = resolveJouzuPaths({ homeOverride: process.env.JOUZU_HOME });
  const { readProfileChoice, writeProfileChoice } = await load('profile-choice');
  const agentRoot = join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist');
  const pi = name => import(pathToFileURL(join(agentRoot, 'core', `${name}.js`)));
  const { AuthStorage } = await pi('auth-storage');
  const { ModelRuntime } = await pi('model-runtime');
  const { SettingsManager } = await pi('settings-manager');
  const auth = AuthStorage.create(join(paths.agentDir, 'auth.json'));
  const settings = SettingsManager.create(paths.configDir, paths.agentDir);
  const runtime = await ModelRuntime.create({ authPath: join(paths.agentDir, 'auth.json'), modelsPath: join(paths.agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  // Model availability is the published catalog, not a hardcoded provider list.
  const refreshModelCatalogs = async () => {
    const { refreshAvailableModelCatalogs } = await load('model-catalog-sync');
    return refreshAvailableModelCatalogs(paths, { env: process.env, timeoutMs: 20000 });
  };
  const profilePath = join(paths.stateDir, 'profile-choice.json');
  if (request.action === 'profile') {
    if (!['core', 'ja'].includes(request.profile)) throw new Error('Invalid profile');
    const { loadBundledProfile } = await load('profiles');
    const { applyProfile } = await load('profile-manager');
    const { loadMetadata } = await load('metadata');
    applyProfile(loadBundledProfile(request.profile), paths, loadMetadata().jouzuVersion);
    writeProfileChoice(profilePath, request.profile);
  } else if (request.action === 'import') {
    if (typeof request.accept !== 'boolean') throw new Error('Invalid import decision');
    const { offerPiConfigurationImport } = await load('pi-import');
    await offerPiConfigurationImport(paths, {
      inheritedAgentDir: process.env.PI_CODING_AGENT_DIR,
      ask: async () => request.accept ? 'yes' : 'no',
      output: { write: () => true },
    });
  } else if (request.action === 'shisa-login') {
    const { loginShisa } = await load('shisa-link/login');
    const { resolveShisaGatewayUrl } = await load('shisa-link/device-flow');
    const { loadMetadata } = await load('metadata');
    await loginShisa({
      signal: AbortSignal.timeout(180000),
      onDeviceCode: ({ verificationUri, userCode }) => process.stderr.write(JSON.stringify({ type: 'device', url: verificationUri, code: userCode }) + String.fromCharCode(10)),
      onAuth: () => {}, onProgress: () => {}, onSelect: async () => undefined,
      onPrompt: async () => { throw new Error('Unsupported interactive prompt'); },
    }, { paths, gatewayUrl: resolveShisaGatewayUrl(process.env), jouzuVersion: loadMetadata().jouzuVersion });
    // Signing in must make the account's models usable without a terminal /reload.
    try { catalog = catalogOutcome(await refreshModelCatalogs()); } catch { /* The next explicit refresh can report it. */ }
  } else if (request.action === 'language') {
    // Jouzu's own Settings save: one localization.json, its lock, revision check and backup.
    const { applyLocalization } = await load('localization-ops');
    const change = {};
    for (const key of ['uiLocale', 'responseLanguage', 'artifactPolicy']) if (request[key] !== undefined) change[key] = request[key];
    if (!Object.keys(change).length) throw new Error('Invalid language request');
    applyLocalization(paths, { sessionId: 'settings', scope: 'environment', request: change });
  } else if (request.action === 'refresh-catalogs') {
    const refreshed = await refreshModelCatalogs();
    catalog = catalogOutcome(refreshed);
    // A held revision and an unconfigured install are answers, not failures. Only a
    // refresh that could not read any source is an error the user must act on.
    if (catalog.status === 'failed' || catalog.status === 'partial') throw new Error('Catalog refresh failed');
  } else if (request.action === 'catalog-accept' || request.action === 'catalog-reject') {
    const revision = typeof request.revision === 'string' ? request.revision : '';
    const digest = typeof request.digest === 'string' ? request.digest : '';
    if (!revision || !digest) throw new Error('Invalid catalog revision');
    const sync = await load('model-catalog-sync');
    const sourceId = typeof request.sourceId === 'string' && request.sourceId ? request.sourceId : undefined;
    const decided = request.action === 'catalog-accept'
      ? sync.acceptQuarantinedCatalog(paths, revision, digest, process.env, new Date(), sourceId)
      : sync.rejectHeldCatalog(paths, revision, digest, process.env, new Date(), sourceId);
    catalog = { status: decided?.status ?? 'unknown', sources: [], held: null };
    if (catalog.status === 'failed') throw new Error('Catalog decision failed');
  } else if (request.action === 'shisa-logout') {
    const { logoutShisa } = await load('shisa-link/logout');
    const result = await logoutShisa({ paths });
    if (!result.localCleared) throw new Error('Local signout failed');
    signOutRevocation = result.revocation;
  } else if (request.action === 'provider-oauth') {
    const providerId = request.provider;
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error('Unknown provider');
    if (!provider.auth?.oauth) throw new Error('This provider does not use OAuth');
    if (providerId === 'shisa') throw new Error('Use the Shisa.AI sign-in');
    // The control service is one request per process: wait for the browser
    // callback (or the device code) here, then persist the credential before
    // reporting status so the next runtime process sees it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const deviceIdPath = join(paths.agentDir, 'device-id');
    const readDeviceId = () => {
      if (existsSync(deviceIdPath)) {
        const value = readFileSync(deviceIdPath, 'utf8').trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
      }
      const value = randomUUID();
      try { writeFileSync(deviceIdPath, `${value}\n`); } catch { /* the in-memory id still works */ }
      return value;
    };
    try {
      await runtime.login(providerId, 'oauth', {
        signal: controller.signal,
        async prompt(prompt) {
          if (prompt.type === 'select') {
            // Device code matches the Shisa.AI sign-in surface; browser login is
            // still used for providers that only offer the callback flow.
            return prompt.options.find(option => option.id === 'device_code')?.id ?? prompt.options[0].id;
          }
          // A browser flow races this paste prompt against the callback. Keep it
          // pending; the callback resolves the login, and abort cancels it.
          return await new Promise((_, reject) => {
            const abort = () => reject(new Error('Login cancelled'));
            if (prompt.signal?.aborted || controller.signal.aborted) { abort(); return; }
            prompt.signal?.addEventListener('abort', abort, { once: true });
            controller.signal.addEventListener('abort', abort, { once: true });
          });
        },
        notify(event) {
          if (event.type === 'device_code') {
            process.stderr.write(JSON.stringify({ type: 'device', provider: providerId, url: event.verificationUri, code: event.userCode }) + String.fromCharCode(10));
          } else if (event.type === 'auth_url') {
            process.stderr.write(JSON.stringify({ type: 'device', provider: providerId, url: event.url, code: '' }) + String.fromCharCode(10));
          }
        },
      }, { agentName: 'Jouzu', getDeviceId: readDeviceId });
    } finally {
      clearTimeout(timer);
    }
    try { await refreshModelCatalogs(); } catch { /* The next explicit refresh can report it. */ }
  } else if (request.action === 'custom-provider') {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(request.provider) || request.provider === 'shisa') throw new Error('Invalid provider');
    const url = new URL(request.url);
    if (url.username || url.password || !(['https:'].includes(url.protocol) || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('Invalid endpoint');
    if (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 256) throw new Error('Invalid model');
    const { ensurePrivateDirectory, writeFilePrivateAtomic } = await load('private-fs');
    ensurePrivateDirectory(paths.agentDir);
    const file = join(paths.agentDir, 'models.json');
    const require = createRequire(join(appRoot, 'node_modules/jouzu/package.json'));
    const lock = require('proper-lockfile');
    const release = await lock.lock(file, { realpath: false, retries: 0 });
    const staged = join(paths.agentDir, 'models.launcher-validation.json');
    try {
      const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { providers: {} };
      config.providers ??= {};
      const existing = config.providers[request.provider];
      if (request.edit !== true && (existing || runtime.getProvider(request.provider))) throw new Error('Provider already exists');
      if (request.edit === true && (!existing || existing.api !== 'openai-completions' || existing.models?.length !== 1)) throw new Error('This provider requires advanced editing');
      const imageInput = request.imageInput === true;
      const contextWindow = request.contextWindow === undefined ? 32768 : Number(request.contextWindow);
      if (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2_000_000) throw new Error('Invalid context window');
      const maxTokens = request.maxTokens === undefined ? 4096 : Number(request.maxTokens);
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error('Invalid max output');
      const previous = existing?.models?.[0];
      config.providers[request.provider] = { ...existing, baseUrl: url.href, api: 'openai-completions', authHeader: true, models: [{ ...previous, id: request.model.trim(), name: request.model.trim(), reasoning: previous?.reasoning ?? false, cost: previous?.cost ?? {input:0,output:0,cacheRead:0,cacheWrite:0}, input: imageInput ? ['text', 'image'] : ['text'], contextWindow, maxTokens }] };
      writeFilePrivateAtomic(staged, JSON.stringify(config), paths.agentDir);
      const { ModelConfig } = await pi('model-config');
      const validated = await ModelConfig.load(staged);
      if (validated.getError()) throw new Error('Invalid model configuration');
      writeFilePrivateAtomic(file, JSON.stringify(config, null, 2), paths.agentDir);
    } finally {
      if (existsSync(staged)) unlinkSync(staged);
      await release();
    }
  } else if (request.action === 'provider-key') {
    if (!runtime.getProvider(request.provider)) throw new Error('Unknown provider');
    if (typeof request.token !== 'string' || !request.token.trim() || /^[!$]/.test(request.token.trim()) || request.token.length > 8192 || [...request.token].some(c => c.charCodeAt(0) < 32)) throw new Error('Invalid key');
    await auth.modify(request.provider, async () => ({ type: 'api_key', key: request.token.trim() }));
  } else if (request.action === 'provider-remove') {
    if (!runtime.getProvider(request.provider)) throw new Error('Unknown provider');
    await auth.delete(request.provider);
  } else if (request.action === 'default-model') {
    // The runtime's own registry decides which models exist: a default it
    // does not know would be saved while the runtime starts on another model.
    const name = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && ![...value].some(c => c.charCodeAt(0) < 32);
    if (!name(request.provider) || !name(request.model) || !runtime.getModel(request.provider, request.model)) throw new Error('Unknown model');
    settings.setDefaultModelAndProvider(request.provider, request.model);
    await settings.flush();
  } else if (request.action !== 'status') throw new Error('Unsupported operation');
  if (request.action === "custom-provider") await runtime.refresh({ allowNetwork: false });
  const { ModelConfig } = await pi('model-config');
  const savedConfig = await ModelConfig.load(join(paths.agentDir, 'models.json'));
  const customProviders = savedConfig.getProviderIds().map(id => {
    const p = savedConfig.getProvider(id);
    const m = p.models?.[0]; return { id, url: p.baseUrl, model: m?.id, editable: p.api === 'openai-completions' && p.models?.length === 1, imageInput: Array.isArray(m?.input) && m.input.includes('image'), contextWindow: m?.contextWindow, maxTokens: m?.maxTokens };
  });
  const { readShisaAccountStatus } = await load('shisa-link/account');
  const account = { ...readShisaAccountStatus(paths), ...(signOutRevocation ? { revocation: signOutRevocation } : {}) };
  const credentials = await auth.list();
  // The language a new runtime starts with, resolved the way Jouzu's startup does.
  const { readLocalizationSettings, resolveUiLocale, osLocaleCandidates } = await load('ui-locale');
  const { resolveResponseLanguage, resolveArtifactPolicy } = await load('language-settings');
  const saved = readLocalizationSettings(paths.configDir);
  const savedSettings = saved.status === 'ok' ? saved.settings : undefined;
  const pick = ({ requested, effective, source }) => ({ requested, effective, source });
  const language = {
    status: saved.status,
    uiLocale: pick(resolveUiLocale({ ...(process.env.JOUZU_UI_LOCALE ? { env: process.env.JOUZU_UI_LOCALE } : {}), config: saved, os: osLocaleCandidates(process.env) })),
    responseLanguage: pick(resolveResponseLanguage({ config: savedSettings?.responseLanguage })),
    artifactPolicy: pick(resolveArtifactPolicy(savedSettings?.artifactPolicy ? { config: savedSettings.artifactPolicy } : {})),
  };
  // Readiness means the user has configured a usable model source, matching the
  // conditions Jouzu's own doctor reports as "provider.unconfigured".
  const modelReady = account.signedIn || credentials.length > 0 || customProviders.length > 0;
  console.log(JSON.stringify({ schemaVersion: 1, modelReady, ...(catalog ? { catalog } : {}), language, profile: readProfileChoice(profilePath)?.profile ?? null, account, customProviders, providers: runtime.getProviders().map(p => ({ id: p.id, name: p.id === 'openai-codex' ? 'Codex' : (p.name ?? p.id), oauth: !!p.auth?.oauth, oauthName: p.auth?.oauth?.name, apiKey: !!p.auth?.apiKey })), credentials, defaultProvider: settings.getDefaultProvider(), defaultModel: settings.getDefaultModel() }));
} catch {
  // Do not relay raw upstream errors: they can contain credentials or server input.
  const messages = {
    status: 'Could not read Jouzu configuration. No settings were changed.',
    profile: 'Could not apply the Jouzu profile. Existing profile files may conflict; the selection was not marked complete.',
    'provider-key': 'Could not save the provider key. Check the provider selection and retry.',
    'provider-remove': 'Could not remove the provider key. Refresh its state before retrying.',
    'custom-provider': 'Could not save the custom connection. Check its unique ID, endpoint and model. Existing advanced configurations cannot be edited with this form.',
    'default-model': 'Could not save the default model. Refresh the model list and retry.',
    'shisa-login': 'Shisa.AI sign-in did not complete. Refresh its state before retrying.',
    'provider-oauth': 'Provider sign-in did not complete. Refresh its state before retrying.',
    'refresh-catalogs': 'Models could not be refreshed. Sign in to Shisa.AI again or add a provider key.',
    'catalog-accept': 'The held catalog could not be applied. Refresh the model list and retry.',
    'catalog-reject': 'The held catalog could not be discarded. Refresh the model list and retry.',
    language: 'Could not save the language settings. The Jouzu language file may be unreadable or changed elsewhere; nothing was overwritten.',
    'shisa-logout': 'Shisa.AI sign-out could not be fully confirmed. Refresh its state and check the Shisa.AI dashboard.',
  };
  console.log(JSON.stringify({ error: messages[action] ?? 'Unsupported configuration operation.' }));
  process.exitCode = 1;
}






