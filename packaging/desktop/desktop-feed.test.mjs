import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopFeed, writeDesktopFeed } from './desktop-feed.mjs';

const base = {
	version: '1.0.1',
	notes: '- Desktop-only release',
	pubDate: '2026-10-23T04:00:00Z',
	repository: 'shisa-ai/jouzu-desktop',
	assetName: 'JouzuDesktop_1.0.1_x64-setup.exe',
	signature: '  dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo  \n',
};

test('the feed names the version release asset for the Windows target', () => {
	const feed = desktopFeed(base);
	assert.equal(feed.version, '1.0.1');
	assert.equal(feed.pub_date, '2026-10-23T04:00:00.000Z');
	assert.deepEqual(feed.platforms, {
		'windows-x86_64': {
			signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo',
			url: 'https://github.com/shisa-ai/jouzu-desktop/releases/download/v1.0.1/JouzuDesktop_1.0.1_x64-setup.exe',
		},
	});
});

test('an invalid version, repository, asset name, signature or date is refused', () => {
	const cases = [
		{ version: '1.0' },
		{ version: '1.0.1-beta' },
		{ repository: 'no-slash' },
		{ repository: 'owner/' },
		{ assetName: 'Jouzu Desktop_1.0.1_x64-setup.exe' },
		{ assetName: 'setup.zip' },
		{ assetName: '' },
		{ signature: '   ' },
		{ pubDate: 'not a date' },
	];
	for (const overrides of cases) {
		assert.throws(() => desktopFeed({ ...base, ...overrides }), Error, JSON.stringify(overrides));
	}
});

test('the feed file is UTF-8 without a byte order mark', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-feed-'));
	const path = join(directory, 'latest.json');
	writeDesktopFeed(path, desktopFeed(base));
	const bytes = readFileSync(path);
	assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
	assert.ok(bytes.toString('utf8').endsWith('\n'));
	assert.equal(JSON.parse(bytes.toString('utf8')).platforms['windows-x86_64'].signature, 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo');
});

// QA releases are release candidates (#86); their feed carries the rc version.
test('a release candidate version is accepted', () => {
	const feed = desktopFeed({ ...base, version: '1.1.3-rc.1', assetName: 'JouzuDesktop_1.1.3-rc.1_x64-setup.exe' });
	assert.equal(feed.version, '1.1.3-rc.1');
	assert.equal(feed.platforms['windows-x86_64'].url, 'https://github.com/shisa-ai/jouzu-desktop/releases/download/v1.1.3-rc.1/JouzuDesktop_1.1.3-rc.1_x64-setup.exe');
});
