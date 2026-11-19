import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFeed } from './verify-feed.mjs';

const feed = version => JSON.stringify({ version, platforms: { 'windows-x86_64': { url: `https://example.test/v${version}/setup.exe`, signature: 's' } } }, null, 2);

function server(answers) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (options.method === 'HEAD') return { ok: true, status: 200 };
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (typeof answer === 'number') return { ok: false, status: answer, text: async () => '' };
    return { ok: true, status: 200, text: async () => answer };
  };
  return { fetchImpl, calls };
}

const clock = () => {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
};

// The 1.1.0 and 1.1.1 QA releases published correctly but failed this step: the first
// read got 404 (a new feed tag) or the previous feed (CDN), and the step gave up at once.
test('waits through a 404 and a stale feed until the published one is served', async () => {
  const { fetchImpl, calls } = server([404, 404, feed('1.1.0'), feed('1.1.0'), feed('1.1.1')]);
  const result = await verifyFeed({ endpoint: 'https://example.test/latest.json', expected: feed('1.1.1'), fetchImpl, ...clock(), log: () => {} });
  assert.equal(result.attempts, 5);
  assert.equal(result.asset, 'https://example.test/v1.1.1/setup.exe');
  assert.ok(calls.some(call => call.method === 'HEAD' && call.url === result.asset));
  // Every read asks past caches.
  assert.equal(new Set(calls.filter(call => call.method === 'GET').map(call => call.url)).size, 5);
});

test('fails with the reason when the feed never matches before the deadline', async () => {
  const { fetchImpl } = server([feed('1.1.0')]);
  await assert.rejects(
    verifyFeed({ endpoint: 'https://example.test/latest.json', expected: feed('1.1.1'), deadlineMs: 60_000, fetchImpl, ...clock(), log: () => {} }),
    /did not match within 60 s .*version 1\.1\.0/,
  );
});

test('fails when the installer the feed names cannot be read', async () => {
  const fetchImpl = async (url, options = {}) => options.method === 'HEAD' ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => feed('1.1.1') };
  await assert.rejects(
    verifyFeed({ endpoint: 'https://example.test/latest.json', expected: feed('1.1.1'), deadlineMs: 30_000, fetchImpl, ...clock(), log: () => {} }),
    /installer HTTP 404/,
  );
});
