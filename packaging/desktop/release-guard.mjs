import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Release rules for Jouzu Desktop's two feeds (#86).
 *
 * QA and stable are two builds of the same code on two feeds; the installed package and
 * the update channel are independent. QA releases are release candidates, `X.Y.Z-rc.N`.
 * A stable release `X.Y.Z` is built again from the commit of a published QA release
 * `X.Y.Z-rc.N`, must pass the full playbook, and is signed. Both feeds only move
 * forward: a release that would hand any installed client an older build is refused. */

const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

/** [major, minor, patch, rc] with rc = null for a stable version. */
export function parseVersion(text) {
	const match = typeof text === 'string' ? pattern.exec(text.trim()) : null;
	if (!match) throw new Error(`Not a release version: ${JSON.stringify(text)}`);
	return [...match.slice(1, 4).map(Number), match[4] === undefined ? null : Number(match[4])];
}

export const isReleaseCandidate = text => parseVersion(text)[3] !== null;

/** Semver order: 1.1.3-rc.1 < 1.1.3-rc.2 < 1.1.3 < 1.1.4-rc.1. */
export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let index = 0; index < 3; index += 1) {
		if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
	}
	if (left[3] === right[3]) return 0;
	if (left[3] === null) return 1;
	if (right[3] === null) return -1;
	return left[3] < right[3] ? -1 : 1;
}

/** The stable version a release candidate becomes: 1.1.3-rc.2 → 1.1.3. */
export function stableVersionOf(candidate) {
	const [major, minor, patch, rc] = parseVersion(candidate);
	if (rc === null) throw new Error(`${candidate} is not a release candidate (X.Y.Z-rc.N).`);
	return `${major}.${minor}.${patch}`;
}

/** The version a published feed serves, or null when that feed has never been published. */
export function feedVersion(feed) {
	if (feed === null || feed === undefined) return null;
	const version = feed?.version;
	parseVersion(version);
	return version;
}

/** A QA build is a release candidate newer than everything either feed serves, with a new tag. */
export function checkQaPublish({ version, stable, qa, tagExists }) {
	if (!isReleaseCandidate(version)) throw new Error(`Refusing ${version}: QA releases are release candidates, X.Y.Z-rc.N.`);
	if (tagExists) throw new Error(`v${version} already exists; a published build is never replaced. Use a new version.`);
	for (const [name, current] of [['stable', stable], ['QA', qa]]) {
		if (current !== null && compareVersions(version, current) <= 0) {
			throw new Error(`Refusing ${version}: the ${name} feed already serves ${current}. Releases only move forward.`);
		}
	}
}

/** A stable build: from a published QA release candidate, with a new tag, moving stable forward. */
export function checkStable({ candidate, stable, candidateRelease, tagExists }) {
	const version = stableVersionOf(candidate);
	if (!candidateRelease) throw new Error(`v${candidate} was never published to QA. Every stable release is built from a QA release candidate.`);
	if (!candidateRelease.prerelease) throw new Error(`v${candidate} is not a QA prerelease.`);
	if (tagExists) throw new Error(`v${version} already exists; a published build is never replaced.`);
	if (stable !== null && compareVersions(version, stable) <= 0) {
		throw new Error(`Refusing ${version}: stable already serves ${stable}. Stable only moves forward.`);
	}
	return version;
}

async function readFeed(url) {
	const response = await fetch(url, { redirect: 'follow' });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Cannot read ${url}: HTTP ${response.status}`);
	return response.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// node release-guard.mjs qa <X.Y.Z-rc.N> <owner/repo> <tag-exists|->
	// node release-guard.mjs stable <X.Y.Z-rc.N> <owner/repo> <candidate-release-json|-> <tag-exists|->
	const [mode, version, repository, extra, extra2] = process.argv.slice(2);
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Usage: node release-guard.mjs <qa|stable> <version> <owner/repo> <extra>');
	const base = `https://github.com/${repository}/releases/download`;
	const stable = feedVersion(await readFeed(`${base}/desktop-update/latest.json`));
	const qa = feedVersion(await readFeed(`${base}/desktop-update-qa/latest.json`));
	if (mode === 'qa') {
		checkQaPublish({ version, stable, qa, tagExists: extra === 'tag-exists' });
		console.log(`ok: qa ${version} (stable ${stable ?? 'none'}, QA ${qa ?? 'none'})`);
	} else if (mode === 'stable') {
		const { readFileSync } = await import('node:fs');
		const release = extra && extra !== '-' ? JSON.parse(readFileSync(extra, 'utf8')) : null;
		const built = checkStable({ candidate: version, stable, candidateRelease: release && { prerelease: release.isPrerelease ?? release.prerelease }, tagExists: extra2 === 'tag-exists' });
		console.log(`ok: stable ${built} from ${version} (stable ${stable ?? 'none'}, QA ${qa ?? 'none'})`);
	} else {
		throw new Error(`Unknown mode ${mode}`);
	}
}
