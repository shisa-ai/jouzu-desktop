import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./bug-report.mjs', import.meta.url));
// The payload this repository has already prepared, when there is one: the app reports through the
// reporter that release carries, so the check runs against it rather than against a copy of it.
const prepared = fileURLToPath(new URL('../../apps/desktop/src-tauri/target/release/app', import.meta.url));

function run(app, facts) {
  const space = mkdtempSync(join(tmpdir(), 'bug-report-'));
  const file = join(space, 'facts.json');
  writeFileSync(file, JSON.stringify(facts));
  const result = spawnSync(process.execPath, [script, app, file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const facts = {
  description: 'Jouzu closed the window right after opening the folder.',
  runtimeIdentity: 'Jouzu Desktop 1.1.4, install C:/jouzu',
};

test('the payload reporter builds the draft and the app adds only what it knows', {
  skip: existsSync(prepared) ? false : 'no prepared payload in this checkout',
}, () => {
  const answer = run(prepared, facts);
  assert.equal(answer.available, true);
  // The sections and their wording are the payload's; the app contributes its identity and nothing
  // else about the draft.
  for (const section of ['## What happened', '## Expected behavior', '## Actual behavior', '## Steps to reproduce', '## Environment']) {
    assert.ok(answer.body.includes(section), section);
  }
  assert.ok(answer.body.includes('- Runtime: Jouzu Desktop 1.1.4, install C:/jouzu'), answer.body);
  assert.ok(answer.body.includes('Not provided.'), answer.body);
  assert.equal(answer.title, facts.description);
  assert.equal(answer.issueUrl, 'https://github.com/shisa-ai/jouzu/issues/new');
});

test('a release whose reporter is not there is reported as such, not replaced by a second draft', () => {
  const answer = run(mkdtempSync(join(tmpdir(), 'bug-report-empty-')), facts);
  assert.equal(answer.available, false);
  assert.equal(answer.issueUrl, 'https://github.com/shisa-ai/jouzu/issues/new');
  assert.deepEqual(answer.facts, facts);
});
