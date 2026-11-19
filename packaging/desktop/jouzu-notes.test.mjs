import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotesSection, repositorySlug, fetchReleaseNotes } from './jouzu-notes.mjs';

const changelog = `# Changelog\n\n## 0.1.18 - 2026-09-30\n\n### Changed\n\n- Show background jobs in the work dashboard.\n\n### Fixed\n\n- Continue a running loop after a non-loop turn.\n\n## 0.1.17 - 2026-09-29\n\n- Older notes.\n`;

test('the notes cover one version only', () => {
	const notes = releaseNotesSection(changelog, '0.1.18');
	assert.match(notes, /background jobs/);
	assert.match(notes, /Continue a running loop/);
	assert.doesNotMatch(notes, /Older notes/);
	assert.equal(releaseNotesSection(changelog, '0.0.1'), null);
});

test('the repository comes from published metadata', () => {
	assert.deepEqual(repositorySlug({ repository: { url: 'git+https://github.com/shisa-ai/jouzu.git' } }), { owner: 'shisa-ai', repo: 'jouzu' });
	assert.deepEqual(repositorySlug({ repository: 'github:shisa-ai/jouzu' }), { owner: 'shisa-ai', repo: 'jouzu' });
	assert.throws(() => repositorySlug({}), /GitHub repository/);
});

test('missing notes become an explicit marker instead of an empty description', async () => {
	const metadata = { repository: 'https://github.com/shisa-ai/jouzu.git', gitHead: '5'.repeat(40) };
	const ok = await fetchReleaseNotes({ metadata, version: '0.1.18', fetchImpl: async () => ({ ok: true, text: async () => changelog }) });
	assert.match(ok.notes, /background jobs/);
	assert.equal(ok.notesSource, `shisa-ai/jouzu@${'5'.repeat(7)} CHANGELOG.md`);
	const missing = await fetchReleaseNotes({ metadata, version: '0.1.18', fetchImpl: async () => ({ ok: false }) });
	assert.equal(missing.notes, '');
	assert.match(missing.notesSource, /^unavailable \(shisa-ai\/jouzu@/);
	const noCommit = await fetchReleaseNotes({ metadata: { repository: 'https://github.com/shisa-ai/jouzu' }, version: '0.1.18', fetchImpl: async () => ({ ok: true, text: async () => changelog }) });
	assert.match(noCommit.notesSource, /^unavailable/);
});

test('a release candidate has its own notes, apart from the stable version (#109)', () => {
	const text = `# Changelog\n\n## 1.1.3 - 2026-11-20\n\n- Stable notes.\n\n## 1.1.3-rc.1 - 2026-11-15\n\n- Candidate notes.\n\n## 1.1.2 - 2026-11-15\n\n- Older notes.\n`;
	assert.equal(releaseNotesSection(text, '1.1.3-rc.1'), '- Candidate notes.');
	assert.equal(releaseNotesSection(text, '1.1.3'), '- Stable notes.');
	assert.equal(releaseNotesSection(text.replace(/## 1\.1\.3 - .*\n\n- Stable notes\.\n\n/, ''), '1.1.3'), null);
	assert.throws(() => releaseNotesSection(text, '1.1.3-beta.1'), /Invalid release version/);
});
