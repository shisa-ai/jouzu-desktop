import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Release rules for Jouzu Desktop's two feeds.
 *
 * QA and stable are the same application and the same user data on two feeds. A build is
 * published to QA first; promotion points the stable feed at that same signed asset. The
 * rules here keep both feeds moving forward only: a release that would hand any installed
 * client an older build is refused, whichever feed it targets. */

const plain = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text) {
	const match = typeof text === 'string' ? plain.exec(text.trim()) : null;
	if (!match) throw new Error(`Not a release version: ${JSON.stringify(text)}`);
	return match.slice(1, 4).map(Number);
}

export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	return 0;
}

/** The version a published feed serves, or null when that feed has never been published. */
export function feedVersion(feed) {
	if (feed === null || feed === undefined) return null;
	const version = feed?.version;
	parseVersion(version);
	return version;
}

/** A new QA build must be newer than everything either feed serves, and its tag must be new. */
export function checkQaPublish({ version, stable, qa, tagExists }) {
	parseVersion(version);
	if (tagExists) throw new Error(`v${version} already exists; a published build is never replaced. Use a new version.`);
	for (const [name, current] of [['stable', stable], ['QA', qa]]) {
		if (current !== null && compareVersions(version, current) <= 0) {
			throw new Error(`Refusing ${version}: the ${name} feed already serves ${current}. Releases only move forward.`);
		}
	}
}

/** Promotion: the build must already be a QA release, and stable may only move forward. */
export function checkPromotion({ version, stable, qa, release }) {
	parseVersion(version);
	if (!release) throw new Error(`v${version} was never published to QA. Every stable release ships on QA first.`);
	if (!release.prerelease) throw new Error(`v${version} is already a stable release.`);
	if (qa === null || compareVersions(version, qa) > 0) {
		throw new Error(`v${version} is newer than what the QA feed serves (${qa ?? 'nothing'}); it was never offered to QA.`);
	}
	if (stable !== null && compareVersions(version, stable) <= 0) {
		throw new Error(`Refusing ${version}: stable already serves ${stable}. Stable only moves forward.`);
	}
}

async function readFeed(url) {
	const response = await fetch(url, { redirect: 'follow' });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Cannot read ${url}: HTTP ${response.status}`);
	return response.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// node release-guard.mjs <qa|promote> <version> <owner/repo> <tag-exists|release-json-file|->
	const [mode, version, repository, extra] = process.argv.slice(2);
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Usage: node release-guard.mjs <qa|promote> <version> <owner/repo> <extra>');
	const base = `https://github.com/${repository}/releases/download`;
	const stable = feedVersion(await readFeed(`${base}/desktop-update/latest.json`));
	const qa = feedVersion(await readFeed(`${base}/desktop-update-qa/latest.json`));
	if (mode === 'qa') {
		checkQaPublish({ version, stable, qa, tagExists: extra === 'tag-exists' });
	} else if (mode === 'promote') {
		const { readFileSync } = await import('node:fs');
		const release = extra && extra !== '-' ? JSON.parse(readFileSync(extra, 'utf8')) : null;
		checkPromotion({ version, stable, qa, release: release && { prerelease: release.isPrerelease ?? release.prerelease } });
	} else {
		throw new Error(`Unknown mode ${mode}`);
	}
	console.log(`ok: ${mode} ${version} (stable ${stable ?? 'none'}, QA ${qa ?? 'none'})`);
}
