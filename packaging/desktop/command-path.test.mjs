import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./command-path.ps1', import.meta.url));
const pwsh = process.env.JOUZU_TEST_PWSH ?? 'pwsh';

function run(args) {
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function workspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, install: join(root, 'install'), bin: join(root, 'bin') };
}
// The shims are executed, not read: the fixture stands in for the console, so a shim that forwards its
// arguments prints them.
function consoleFixture(space) {
  mkdirSync(space.install, { recursive: true });
  for (const name of ['jz.exe', 'jouzu.exe']) {
    const target = join(space.install, name);
    // A link shares the signed bytes; a copy is the fallback where the file system refuses one.
    try { linkSync(process.execPath, target); } catch { copyFileSync(process.execPath, target); }
  }
}
// The expression carries no quotes, so every shell forwards it as written; the count of arguments is
// what proves the entry received them.
const printArguments = ['-p', 'process.argv.length'];

test('the report says where the entry stands and what a new shell would run', () => {
  const space = workspace('path-report-');
  const entries = [space.bin, 'C:/other'];
  const state = run(['-Directory', space.bin, '-PathValue', entries.join(';')]);
  assert.equal(state.onPath, true);
  assert.equal(state.position, 'first');
  assert.deepEqual(state.value, entries);
  const absent = run(['-Directory', space.bin, '-PathValue', 'C:/a;;C:/b']);
  assert.equal(absent.onPath, false);
  assert.equal(absent.position, 'absent');
  // An empty entry does not survive the read, and the order is what a shell scans.
  assert.deepEqual(absent.value, ['C:/a', 'C:/b']);
});

test('the entry is added at the end, moved to the front when authorized, and removed alone', () => {
  const space = workspace('path-change-');
  const value = ['C:/one', 'C:/two'].join(';');
  const added = run(['-Directory', space.bin, '-Action', 'Append', '-PathValue', value]);
  assert.deepEqual(added.value, ['C:/one', 'C:/two', space.bin]);
  assert.equal(added.onPath, true);
  assert.equal(added.position, 'later');

  const front = run(['-Directory', space.bin, '-Action', 'Precedence', '-PathValue', added.value.join(';')]);
  assert.deepEqual(front.value, [space.bin, 'C:/one', 'C:/two']);
  assert.equal(front.position, 'first');

  // Putting it back is the same move, reversed: the entry leaves the front and the others keep their
  // order, so the previous resolution answers again.
  const back = run(['-Directory', space.bin, '-Action', 'Append', '-PathValue', front.value.join(';')]);
  assert.deepEqual(back.value, [space.bin, 'C:/one', 'C:/two']);
  // Putting the previous resolution back is the same move the other way: the entry goes to the end and
  // nothing else moves.
  const restored = run(['-Directory', space.bin, '-Action', 'Restore', '-PathValue', back.value.join(';')]);
  assert.deepEqual(restored.value, ['C:/one', 'C:/two', space.bin]);
  assert.equal(restored.position, 'later');
  const removed = run(['-Directory', space.bin, '-Action', 'Remove', '-PathValue', restored.value.join(';')]);
  assert.deepEqual(removed.value, ['C:/one', 'C:/two']);
  assert.equal(removed.onPath, false);
});

test('the shims run the entry in the shell that finds them, and forward what they were given', () => {
  const space = workspace('path-shims-');
  consoleFixture(space);
  const installed = run(['-Directory', space.bin, '-Action', 'Install', '-InstallRoot', space.install]);
  assert.equal(installed.shims, true);
  const expected = '3';
  const shells = [
    ['cmd.exe', ['/d', '/c', join(space.bin, 'jz.cmd'), ...printArguments, 'a', 'b']],
    [pwsh, ['-NoProfile', '-NonInteractive', '-File', join(space.bin, 'jz.ps1'), ...printArguments, 'a', 'b']],
    ['bash', [join(space.bin, 'jouzu'), ...printArguments, 'a', 'b']],
  ];
  for (const [shell, args] of shells) {
    const result = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.ok(result.stdout.trim().endsWith(expected), `${shell}: ${result.stdout}`);
  }
});

test('the user value changes by the entry alone, and survives another tool adding one', () => {
  const valueName = 'JouzuCommandPathTest';
  const space = workspace('path-user-');
  const userValue = `[Environment]::GetEnvironmentVariable('${valueName}','User')`;
  const setValue = value => `[Environment]::SetEnvironmentVariable('${valueName}', ${value === null ? '$null' : `'${value}'`}, 'User')`;
  const read = () => spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', userValue], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.equal(read(), '', 'the test value name must be free before the run');
  try {
    const added = run(['-Directory', space.bin, '-Action', 'Append', '-ValueName', valueName, '-Write']);
    assert.deepEqual(added.value, [space.bin]);
    assert.equal(read(), space.bin);
    assert.equal(added.onPath, true);

    // Something else adds an entry while ours is there; removing ours leaves that one alone.
    const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', setValue(`C:/foreign;${space.bin}`)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const removed = run(['-Directory', space.bin, '-Action', 'Remove', '-ValueName', valueName, '-Write']);
    assert.deepEqual(removed.value, ['C:/foreign']);
    assert.equal(read(), 'C:/foreign');
  } finally {
    spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', setValue(null)], { encoding: 'utf8', windowsHide: true });
  }
});

test('an entry another installation answers with is left alone', () => {
  const space = workspace('path-shadow-');
  const other = join(space.root, 'npm');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'jz.cmd'), '@echo off');
  const value = [other].join(';');
  const state = run(['-Directory', space.bin, '-Action', 'Append', '-PathValue', value]);
  // The user keeps the command they already have, and the report says what answers.
  assert.deepEqual(state.value, [other]);
  assert.equal(state.onPath, false);
  assert.equal(state.shadowed, true);
  assert.equal(state.commands.find(entry => entry.name === 'jz').path, join(other, 'jz.cmd'));

  // Taking precedence is the authorized action, and it is the only one that moves ahead of it.
  const authorized = run(['-Directory', space.bin, '-Action', 'Precedence', '-PathValue', value]);
  assert.deepEqual(authorized.value, [space.bin, other]);
  assert.equal(authorized.position, 'first');
});
