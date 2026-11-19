import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQaPublish, checkStable, compareVersions, feedVersion, isReleaseCandidate, stableVersionOf } from './release-guard.mjs';

test('versions compare numerically, with release candidates before their release', () => {
	assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
	assert.equal(compareVersions('1.0.9', '1.0.9'), 0);
	assert.equal(compareVersions('0.9.99', '1.0.0'), -1);
	assert.equal(compareVersions('1.1.3-rc.1', '1.1.3'), -1);
	assert.equal(compareVersions('1.1.3-rc.2', '1.1.3-rc.10'), -1);
	assert.equal(compareVersions('1.1.3', '1.1.4-rc.1'), -1);
	assert.equal(compareVersions('1.1.3-rc.1', '1.1.2'), 1);
	assert.throws(() => compareVersions('1.0.9-qa.1', '1.0.9'), /Not a release version/);
});

test('a release candidate names the stable version it becomes', () => {
	assert.equal(isReleaseCandidate('1.1.3-rc.2'), true);
	assert.equal(isReleaseCandidate('1.1.3'), false);
	assert.equal(stableVersionOf('1.1.3-rc.2'), '1.1.3');
	assert.throws(() => stableVersionOf('1.1.3'), /not a release candidate/);
});

test('a feed that was never published has no version', () => {
	assert.equal(feedVersion(null), null);
	assert.equal(feedVersion({ version: '1.0.23' }), '1.0.23');
	assert.equal(feedVersion({ version: '1.1.3-rc.1' }), '1.1.3-rc.1');
	assert.throws(() => feedVersion({}), /Not a release version/);
});

test('QA accepts only a release candidate newer than both feeds', () => {
	checkQaPublish({ version: '1.1.3-rc.1', stable: '1.0.23', qa: '1.1.2', tagExists: false });
	checkQaPublish({ version: '1.1.3-rc.2', stable: '1.0.23', qa: '1.1.3-rc.1', tagExists: false });
	checkQaPublish({ version: '1.0.1-rc.1', stable: null, qa: null, tagExists: false });
	assert.throws(() => checkQaPublish({ version: '1.1.3', stable: '1.0.23', qa: '1.1.2', tagExists: false }), /release candidates/);
	assert.throws(() => checkQaPublish({ version: '1.1.3-rc.1', stable: '1.1.3', qa: null, tagExists: false }), /stable feed already serves 1.1.3/);
	assert.throws(() => checkQaPublish({ version: '1.1.3-rc.1', stable: '1.0.23', qa: '1.1.3-rc.1', tagExists: false }), /QA feed already serves 1.1.3-rc.1/);
	assert.throws(() => checkQaPublish({ version: '1.1.3-rc.2', stable: '1.0.23', qa: '1.1.3-rc.1', tagExists: true }), /never replaced/);
});

test('stable is built from a published release candidate and moves stable forward', () => {
	assert.equal(checkStable({ candidate: '1.1.3-rc.2', stable: '1.0.23', candidateRelease: { prerelease: true }, tagExists: false }), '1.1.3');
	assert.throws(() => checkStable({ candidate: '1.1.3', stable: '1.0.23', candidateRelease: { prerelease: true }, tagExists: false }), /not a release candidate/);
	assert.throws(() => checkStable({ candidate: '1.1.3-rc.2', stable: '1.0.23', candidateRelease: null, tagExists: false }), /never published to QA/);
	assert.throws(() => checkStable({ candidate: '1.1.3-rc.2', stable: '1.0.23', candidateRelease: { prerelease: false }, tagExists: false }), /not a QA prerelease/);
	assert.throws(() => checkStable({ candidate: '1.1.3-rc.2', stable: '1.0.23', candidateRelease: { prerelease: true }, tagExists: true }), /never replaced/);
	assert.throws(() => checkStable({ candidate: '1.1.3-rc.2', stable: '1.1.3', candidateRelease: { prerelease: true }, tagExists: false }), /Stable only moves forward/);
});
