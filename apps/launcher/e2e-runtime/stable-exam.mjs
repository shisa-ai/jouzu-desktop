import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { writeLongSession } from './long-session.mjs';
import { hostTiming, hostGateProblem, runLogProblems } from '../e2e/host-timing.mjs';

// The stable release exam (#86): the full user playbook, with a real model, against the
// stable build, on throwaway data folders. Every scenario and every gate must pass;
// nothing is skipped that the exam can run. It never touches a user's data folder.
//
// Inputs (environment):
//   EXAM_MANAGED  folder with the official runtime (runtime/, app/, bin/), provisioned
//                 by the workflow; it plays the installation folder
//   EXAM_HOST     the built jouzu-host executable
//   EXAM_DIST     the built UI
//   PLAYBOOK_SHISA_API_KEY  a Shisa.AI test key (a secret; never printed)
//   PLAYBOOK_OPENROUTER_API_KEY  optional; enables the other image provider scenario
//   EXAM_OUT      where the exam report is written (default stable-exam.json)
const managed = process.env.EXAM_MANAGED;
const hostExe = process.env.EXAM_HOST;
const dist = process.env.EXAM_DIST;
const shisaKey = process.env.PLAYBOOK_SHISA_API_KEY;
const out = resolve(process.env.EXAM_OUT ?? 'stable-exam.json');
for (const [name, value] of Object.entries({ EXAM_MANAGED: managed, EXAM_HOST: hostExe, EXAM_DIST: dist, PLAYBOOK_SHISA_API_KEY: shisaKey })) {
  if (!value) { console.error(`${name} is not set; the stable exam cannot run.`); process.exit(2); }
}
// Shisa.AI's OpenAI-compatible API and a small chat model on it, for the first run.
const SHISA_OPENAI_URL = 'https://api.shisa.ai/v1';
const SHISA_FIRST_RUN_MODEL = 'qwen38-flash-next-nvfp4';
const here = import.meta.dirname;
const launcher = resolve(here, '..');
const extension = resolve(launcher, '..', '..', 'packaging', 'launcher', 'extensions', 'jouzu-image');
const children = [];
const report = { startedAt: new Date().toISOString(), runs: [], pass: false };

/** A throwaway installation: links to the runtime, its own data folder. */
function home(name) {
  const root = mkdtempSync(join(tmpdir(), `jouzu-exam-${name}-`));
  for (const part of ['runtime', 'app', 'bin']) {
    if (existsSync(join(managed, part))) symlinkSync(join(managed, part), join(root, part), 'junction');
  }
  // The image tool the desktop installs at start.
  const target = join(root, 'data', 'agent', 'extensions', 'jouzu-image');
  mkdirSync(target, { recursive: true });
  cpSync(extension, target, { recursive: true });
  return root;
}

async function startHost(root, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.PLAYBOOK_SHISA_API_KEY;
  delete env.PLAYBOOK_OPENROUTER_API_KEY;
  const child = spawn(hostExe, ['--dist', dist, '--home', root, '--runtime-home', join(root, 'data'), '--install', root], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  children.push(child);
  // The host gives its port and API token to its starter on its first output
  // line, and writes the token to no file (#130).
  return await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('The host did not start')), 30_000);
    let text = '';
    child.stdout.on('data', chunk => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
      try { done(JSON.parse(text.slice(0, end))); } catch (error) { fail(error); }
    });
    child.on('exit', code => { clearTimeout(timer); fail(new Error(`The host exited (${code}) before it was ready`)); });
  });
}

async function openBrowser(host, port) {
  const base = `http://127.0.0.1:${host.port}`;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await context.addInitScript(([url, token]) => {
    window.__JOUZU_HOST__ = { baseUrl: url, token };
    if (!localStorage.getItem('jouzu.ui.language')) localStorage.setItem('jouzu.ui.language', 'en');
  }, [base, host.token]);
  const page = await context.newPage();
  await page.goto(base);
  await page.getByText('Connecting to Jouzu…').first().waitFor({ state: 'detached', timeout: 120_000 }).catch(() => {});
  return browser;
}

function run(name, script, env) {
  return new Promise(resolvePromise => {
    const file = join(tmpdir(), `stable-exam-${name}.json`);
    const child = spawn(process.execPath, [script], { cwd: launcher, env: { ...process.env, ...env, PLAYBOOK_OUT: file }, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', code => {
      let result = null;
      try { result = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no report */ }
      resolvePromise({ name, code, result });
    });
  });
}

function judge({ name, code, result }, { allowSkipped = [] } = {}) {
  const problems = [];
  if (!result) problems.push(`no report (exit ${code})`);
  else {
    for (const error of result.errors ?? []) problems.push(`error: ${String(error).split('\n')[0]}`);
    for (const [gate, value] of Object.entries(result.gates ?? {})) if (!value.ok) problems.push(`gate ${gate}: ${value.value} > ${value.limit}`);
    for (const scenario of result.scenarios ?? []) {
      if (scenario.skipped && !allowSkipped.includes(scenario.name)) problems.push(`skipped: ${scenario.name}`);
      else if (!scenario.ok) problems.push(`failed: ${scenario.name}`);
    }
  }
  report.runs.push({ name, problems, result });
  return problems.length === 0;
}

try {
  const imageProviderOptional = process.env.PLAYBOOK_OPENROUTER_API_KEY ? [] : ['P1-image other provider (#65)'];

  // 1. The main flow: Shisa.AI connected through its key, as a user with a key has it.
  const main = home('main');
  const mainHost = await startHost(main, { SHISA_API_KEY: shisaKey });
  let browser = await openBrowser(mainHost, 9224);
  const playbook = await run('playbook', 'e2e/user-playbook.mjs', { PLAYBOOK_CDP: 'http://127.0.0.1:9224', PLAYBOOK_DATA_DIR: join(main, 'data'), PLAYBOOK_IMAGE_PROVIDER: process.env.PLAYBOOK_OPENROUTER_API_KEY ? 'OpenRouter' : '' , PLAYBOOK_SHISA_API_KEY: '' });
  // The Shisa key scenario runs on its own home below, so it is expected to skip here.
  // Web access is managed only in the app's own window, which this exam does not drive.
  judge(playbook, { allowSkipped: ['Shisa key saved in Settings works without restart', 'Web access (#91, #106)', ...imageProviderOptional] });
  // The host's part of a first reply, from this home's host.log over the playbook's run (#117, #129).
  {
    const log = join(main, 'logs', 'host.log');
    const timing = existsSync(log) && playbook.result
      ? hostTiming(readFileSync(log, 'utf8'), { from: Date.parse(playbook.result.startedAt), to: Date.parse(playbook.result.finishedAt ?? new Date().toISOString()) })
      : null;
    // A host-internal number: a diagnostic, never the pass criterion (0019). What the
    // person sees (own message, working, first reply) is gated by the playbook itself.
    const note = existsSync(log) ? hostGateProblem(timing) : `no host.log at ${log}`;
    report.runs.push({ name: 'host-timing (diagnostic)', problems: [], note, result: timing });
  }
  await browser.close();
  // The run belongs to the host: a message sent during a reply is read by it, Stop
  // ends it, nothing is lost or sent twice; host.log shows no overlap or refusal.
  browser = await openBrowser(mainHost, 9227);
  const runs = await run('run-ownership', 'e2e/user-playbook.mjs', { PLAYBOOK_CDP: 'http://127.0.0.1:9227', PLAYBOOK_SCENARIO: 'run-ownership', PLAYBOOK_SHISA_API_KEY: '' });
  judge(runs);
  {
    const log = join(main, 'logs', 'host.log');
    const problems = !existsSync(log) ? [`no host.log at ${log}`]
      : runs.result ? runLogProblems(readFileSync(log, 'utf8'), { from: Date.parse(runs.result.startedAt), to: Date.parse(runs.result.finishedAt ?? new Date().toISOString()), expectSteer: true })
      : ['no run-ownership report'];
    report.runs.push({ name: 'run-ownership-log', problems, result: null });
  }
  await browser.close();
  // The host gives its token only to its starter (#130); pass it on.
  const restart = await run('entry-restart', 'e2e-runtime/entry-restart.mjs', { JOUZU_E2E_HOST_HOME: main, JOUZU_E2E_HOST_TOKEN: mainHost.token });
  judge({ ...restart, result: restart.result ?? (restart.code === 0 ? { scenarios: [{ name: 'entry restart', ok: true }] } : null) });

  // 2. A new user's first run: a home never set up asks for the languages, then a
  //    model connection. Shisa.AI sign-in (browser) is checked as offered; the run
  //    itself is completed by adding Shisa.AI's OpenAI-compatible API as a custom
  //    provider with the test key.
  const fresh = home('key');
  const freshHost = await startHost(fresh, {});
  browser = await openBrowser(freshHost, 9225);
  const key = await run('first-run', 'e2e/user-playbook.mjs', { PLAYBOOK_CDP: 'http://127.0.0.1:9225', PLAYBOOK_SCENARIO: 'first-run', PLAYBOOK_SHISA_API_KEY: '', PLAYBOOK_FIRST_RUN_URL: SHISA_OPENAI_URL, PLAYBOOK_FIRST_RUN_MODEL_ID: SHISA_FIRST_RUN_MODEL, PLAYBOOK_FIRST_RUN_CONTEXT: '262144', PLAYBOOK_FIRST_RUN_API_KEY: shisaKey });
  judge(key);
  await browser.close();

  // 3. A long saved session reads back to its first message and branches from an
  //    early turn (#20). It needs a home that holds that session.
  const long = home('long');
  writeLongSession(join(long, 'data'), join(long, 'long-workspace'));
  const longHost = await startHost(long, { SHISA_API_KEY: shisaKey });
  browser = await openBrowser(longHost, 9226);
  judge(await run('long-session', 'e2e/user-playbook.mjs', { PLAYBOOK_CDP: 'http://127.0.0.1:9226', PLAYBOOK_SCENARIO: 'long-session', PLAYBOOK_SHISA_API_KEY: '' }));
  await browser.close();
} catch (error) {
  report.runs.push({ name: 'exam', problems: [String(error?.message ?? error)] });
} finally {
  for (const child of children) child.kill();
}

report.pass = report.runs.length > 0 && report.runs.every(run => run.problems.length === 0);
report.finishedAt = new Date().toISOString();
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
for (const run of report.runs) console.log(`${run.problems.length ? 'FAIL' : 'PASS'} ${run.name}${run.problems.length ? `: ${run.problems.join('; ')}` : ''}${run.note ? ` (${run.note})` : ''}`);
console.log(report.pass ? 'Stable exam passed.' : 'Stable exam failed.');
process.exit(report.pass ? 0 : 1);
