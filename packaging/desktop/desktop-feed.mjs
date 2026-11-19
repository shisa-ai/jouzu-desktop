import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The update feed is read by the Tauri updater, which looks a platform up by its target key.
 * A platform without an entry simply gets no update. The URL and signature are the only fields
 * the client trusts, so both are validated here rather than assembled in a shell script. */
export function desktopFeed({ version, notes, pubDate, repository, assetName, signature }) {
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) throw new Error('Invalid release version');
	if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid release repository');
	// A space would have to be percent-encoded in the URL; keep release asset names usable as-is.
	if (typeof assetName !== 'string' || !/^[A-Za-z0-9._-]+\.exe$/.test(assetName)) throw new Error('Invalid update asset name');
	if (typeof signature !== 'string' || !signature.trim()) throw new Error('Missing updater signature');
	const date = new Date(pubDate ?? Date.now());
	if (Number.isNaN(date.getTime())) throw new Error('Invalid publication date');
	return {
		version,
		notes: typeof notes === 'string' ? notes : '',
		pub_date: date.toISOString(),
		platforms: {
			'windows-x86_64': {
				signature: signature.trim(),
				url: `https://github.com/${repository}/releases/download/v${version}/${assetName}`,
			},
		},
	};
}

/** The updater reads the feed with a strict JSON parser and no BOM handling. */
export function writeDesktopFeed(path, feed) {
	writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [version, notesFile, repository, assetName, signatureFile, output] = process.argv.slice(2);
	if (!output) throw new Error('Usage: node desktop-feed.mjs <version> <notes-file> <owner/repo> <asset-name> <signature-file> <output>');
	writeDesktopFeed(output, desktopFeed({
		version,
		notes: readFileSync(notesFile, 'utf8').trim(),
		repository,
		assetName,
		signature: readFileSync(signatureFile, 'utf8'),
	}));
}
