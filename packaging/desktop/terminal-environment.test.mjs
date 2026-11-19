import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./terminal-environment.ps1', import.meta.url));
const pwsh = process.env.JOUZU_TEST_PWSH ?? 'pwsh';

// Windows environment names are case-insensitive, so an override has to replace every existing
// spelling; adding PATH beside an inherited Path leaves whichever Windows reads first.
function withEnv(overrides) {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key];
    env[name] = value;
  }
  return env;
}
function run(args, env) {
  return spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: withEnv(env),
  });
}
function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, install: join(root, 'install'), local: join(root, 'local') };
}
// A portable tree is usable when its host executable is present; the script never runs it.
function terminalTree(root, name) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name), '');
  return join(root, name);
}

test('a launch uses the copy Jouzu ships', () => {
  const space = workspace('wt-bundled-');
  const bundled = terminalTree(join(space.install, 'runtime', 'terminal', 'installed'), 'WindowsTerminal.exe');
  const result = run(['-InstallRoot', space.install], { LOCALAPPDATA: space.local });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), bundled);
});

test('a launch falls back to the machine copy, and preparation never does', () => {
  const space = workspace('wt-machine-');
  const machine = terminalTree(join(space.local, 'Microsoft', 'WindowsApps'), 'wt.exe');
  const env = { LOCALAPPDATA: space.local };
  const launch = run(['-InstallRoot', space.install], env);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout.trim(), machine);

  // Preparation needs the copy Jouzu ships, so it fails without printing the machine's copy.
  const prepare = run(['-InstallRoot', space.install, '-Prepare'], env);
  assert.notEqual(prepare.status, 0);
  assert.equal(prepare.stdout.trim(), '');
});

test('a tree that is on disk without its host is reported as present', () => {
  const space = workspace('wt-broken-');
  mkdirSync(join(space.install, 'runtime', 'terminal', 'installed'), { recursive: true });
  const result = run(['-InstallRoot', space.install, '-Report'], { LOCALAPPDATA: space.local });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  // Nothing answers a launch, and the directory is still there, so a repair is what the row offers.
  assert.equal(report.bundled, null);
  assert.equal(report.effective, null);
  assert.equal(report.bundled_present, true);
});

test('the report separates the copies and names the one in use', () => {
  const space = workspace('wt-report-');
  const bundled = terminalTree(join(space.install, 'runtime', 'terminal', 'installed'), 'WindowsTerminal.exe');
  const machine = terminalTree(join(space.local, 'Microsoft', 'WindowsApps'), 'wt.exe');
  const result = run(['-InstallRoot', space.install, '-Report'], { LOCALAPPDATA: space.local });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bundled.path, bundled);
  assert.equal(report.system.path, machine);
  // The copy Jouzu ships is the one a launch resolves when both exist.
  assert.equal(report.effective, bundled);
  assert.equal(report.archive, false);
  assert.equal(report.bundled_present, true);
  assert.match(report.version, /^\d+\.\d+\.\d+\.\d+$/);
});
