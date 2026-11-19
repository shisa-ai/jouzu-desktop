import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNotes } from './release-notes.mjs';

const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');

test('every released version has update notes from the Jouzu changelog', () => {
	const notes = releaseNotes(changelog, '0.2.0');
	assert.match(notes, /Add the Windows launcher/);
	// A section ends at the next version heading, so notes never leak another release's text.
	assert.doesNotMatch(notes, /^## /m);
});

test('a missing or empty section is refused instead of shipping an empty note', () => {
	assert.throws(() => releaseNotes(changelog, '9.9.9'), /Missing changelog section/);
	assert.throws(() => releaseNotes('# Changelog\n\n## 1.0.0 - 2026-10-16\n\n## 0.9.0 - 2026-10-01\n', '1.0.0'), /Missing changelog section/);
	assert.throws(() => releaseNotes(changelog, 'v0.2.0'), /Invalid release version/);
});
