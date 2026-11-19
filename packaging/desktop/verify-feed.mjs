// Verifies a just-published update feed the way an installed app reads it: anonymously,
// from the public release URL. GitHub serves a replaced release asset from its CDN, so
// right after `gh release upload --clobber` the URL can still answer 404 (a new tag) or
// the previous feed for a while. A mismatch is therefore retried until the deadline;
// only a feed that never matches, or an installer that never answers, fails the release.
//
// Usage: node verify-feed.mjs <feed URL> <expected latest.json> [deadline seconds]
import { readFileSync } from 'node:fs';

const PLATFORM = 'windows-x86_64';

export async function verifyFeed({ endpoint, expected, deadlineMs = 300_000, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, log = console.log }) {
  const started = now();
  let wait = 3_000;
  let attempt = 0;
  let last = 'not fetched';
  for (;;) {
    attempt += 1;
    try {
      // A query string makes caches between us and GitHub treat each attempt as new.
      const response = await fetchImpl(`${endpoint}?attempt=${attempt}-${started}`, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
      if (!response.ok) last = `HTTP ${response.status}`;
      else {
        const text = await response.text();
        if (text.trim() === expected.trim()) {
          const feed = JSON.parse(text);
          const asset = feed.platforms?.[PLATFORM]?.url;
          if (typeof asset !== 'string') throw new Error(`The feed has no ${PLATFORM} installer URL.`);
          const head = await fetchImpl(asset, { method: 'HEAD', redirect: 'follow' });
          if (head.ok) {
            log(`feed and installer readable after ${attempt} attempt(s)`);
            return { attempts: attempt, asset };
          }
          last = `installer HTTP ${head.status}`;
        } else {
          let version = 'unreadable';
          try { version = JSON.parse(text).version; } catch { /* not JSON yet */ }
          last = `served feed is version ${version}, not the one just published`;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('The feed has no')) throw error;
      last = String(error?.message ?? error);
    }
    if (now() - started + wait > deadlineMs) throw new Error(`The published feed did not match within ${Math.round(deadlineMs / 1000)} s (${attempt} attempts): ${last}`);
    log(`attempt ${attempt}: ${last}; retrying in ${wait / 1000} s`);
    await sleep(wait);
    wait = Math.min(wait * 2, 30_000);
  }
}

const invoked = typeof process.argv[1] === 'string' && /verify-feed\.mjs$/.test(process.argv[1]);
if (invoked) {
  const [endpoint, file, seconds] = process.argv.slice(2);
  if (!endpoint || !file) {
    console.error('Usage: node verify-feed.mjs <feed URL> <expected latest.json> [deadline seconds]');
    process.exit(2);
  }
  try {
    await verifyFeed({ endpoint, expected: readFileSync(file, 'utf8'), deadlineMs: Number(seconds ?? 300) * 1000 });
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
