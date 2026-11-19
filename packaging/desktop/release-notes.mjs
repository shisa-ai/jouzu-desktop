import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotesSection } from './jouzu-notes.mjs';

// The app update item shows the Jouzu changelog section for the released version, so a release
// cannot ship a feed entry that says nothing about what changed.
export function releaseNotes(changelog, version) {
	const notes = releaseNotesSection(changelog, version);
	if (!notes) throw new Error(`Missing changelog section for ${version}`);
	return notes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [changelogFile, version] = process.argv.slice(2);
	if (!changelogFile || !version) throw new Error('Usage: node release-notes.mjs <changelog> <version>');
	process.stdout.write(releaseNotes(readFileSync(changelogFile, 'utf8'), version));
}
