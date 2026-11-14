import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPromotion, checkQaPublish, compareVersions, feedVersion } from './release-guard.mjs';

test('versions compare numerically, not as text', () => {
	assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
	assert.equal(compareVersions('1.0.9', '1.0.9'), 0);
	assert.equal(compareVersions('0.9.99', '1.0.0'), -1);
	assert.throws(() => compareVersions('1.0.9-qa.1', '1.0.9'), /Not a release version/);
});

test('a feed that was never published has no version', () => {
	assert.equal(feedVersion(null), null);
	assert.equal(feedVersion({ version: '1.0.23' }), '1.0.23');
	assert.throws(() => feedVersion({}), /Not a release version/);
});

test('QA accepts only a build newer than both feeds', () => {
	checkQaPublish({ version: '1.0.24', stable: '1.0.23', qa: '1.0.23', tagExists: false });
	checkQaPublish({ version: '1.0.1', stable: null, qa: null, tagExists: false });
	assert.throws(() => checkQaPublish({ version: '1.0.22', stable: '1.0.23', qa: null, tagExists: false }), /stable feed already serves 1.0.23/);
	assert.throws(() => checkQaPublish({ version: '1.0.24', stable: '1.0.23', qa: '1.0.24', tagExists: false }), /QA feed already serves 1.0.24/);
	assert.throws(() => checkQaPublish({ version: '1.0.25', stable: '1.0.23', qa: '1.0.24', tagExists: true }), /never replaced/);
});

test('promotion needs a QA release and moves stable forward', () => {
	checkPromotion({ version: '1.0.24', stable: '1.0.23', qa: '1.0.25', release: { prerelease: true } });
	assert.throws(() => checkPromotion({ version: '1.0.24', stable: '1.0.23', qa: '1.0.24', release: null }), /never published to QA/);
	assert.throws(() => checkPromotion({ version: '1.0.24', stable: '1.0.23', qa: '1.0.24', release: { prerelease: false } }), /already a stable release/);
	assert.throws(() => checkPromotion({ version: '1.0.26', stable: '1.0.23', qa: '1.0.25', release: { prerelease: true } }), /never offered to QA/);
	assert.throws(() => checkPromotion({ version: '1.0.22', stable: '1.0.23', qa: '1.0.25', release: { prerelease: true } }), /Stable only moves forward/);
});
