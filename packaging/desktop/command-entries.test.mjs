import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./command-entries.ps1', import.meta.url));
const pwsh = process.env.JOUZU_TEST_PWSH ?? 'pwsh';
// A copy is only worth making if it stays signed, and a signature covers the bytes, so the fixture is
// the signed binary this suite already runs under.
const signedBinary = process.execPath;

function run(args) {
  return spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}
function installDirectory(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  copyFileSync(signedBinary, join(root, 'console.exe'));
  return root;
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function signer(path) {
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
    `$s = Get-AuthenticodeSignature -LiteralPath '${path}'; Write-Output "$($s.Status)|$($s.SignerCertificate.Subject)"`], {
    encoding: 'utf8', windowsHide: true,
  });
  return result.stdout.trim();
}

test('both names are the console, byte for byte, and still carry its signature', () => {
  const root = installDirectory('entries-copy-');
  const result = run(['-InstallRoot', root]);
  assert.equal(result.status, 0, result.stderr);
  const consoleDigest = digest(join(root, 'console.exe'));
  for (const name of ['jz.exe', 'jouzu.exe']) {
    assert.ok(existsSync(join(root, name)), name);
    assert.equal(digest(join(root, name)), consoleDigest, name);
    assert.equal(signer(join(root, name)), signer(join(root, 'console.exe')), name);
  }
  // Running it again is what an update does, and it must not change what is there.
  const again = run(['-InstallRoot', root]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(digest(join(root, 'jz.exe')), consoleDigest);
  assert.equal(readdirSync(root).filter(name => name.includes('.old-')).length, 0);
});

test('a copy that is running is renamed aside and refreshed', async () => {
  const root = installDirectory('entries-running-');
  assert.equal(run(['-InstallRoot', root]).status, 0);
  // Windows cannot replace a running image, only rename it aside, so this is what an update meets when
  // a terminal session is open. The fixture is the signed binary, so the copy is a running process.
  const running = spawn(join(root, 'jz.exe'), ['-e', 'setTimeout(() => {}, 15000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => running.once('spawn', resolve));
  await new Promise(resolve => setTimeout(resolve, 500));

  const result = run(['-InstallRoot', root]);
  assert.equal(result.status, 0, result.stderr);
  const console = digest(join(root, 'console.exe'));
  assert.equal(digest(join(root, 'jouzu.exe')), console);
  const aside = readdirSync(root).filter(name => name.startsWith('jz.exe.old-'));
  assert.equal(aside.length, 1, readdirSync(root).join(' '));
  assert.equal(digest(join(root, 'jz.exe')), console);
  // The superseded copy stays until an app start or the uninstall removes it.
  assert.equal(digest(join(root, aside[0])), console);
  running.kill();
});
