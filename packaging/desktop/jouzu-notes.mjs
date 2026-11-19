// The Jouzu update item describes the version being installed. The published npm package ships
// no changelog, so the notes are read from the upstream changelog at the exact commit the
// registry reports for the release, and travel inside the signed recipe manifest.

const MAX_NOTES_BYTES = 8192;
const MAX_SOURCE_BYTES = 256;

/** Extract one version's section. Upstream headings look like `## 0.1.18 - 2026-09-30`. */
export function releaseNotesSection(changelog, version) {
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) throw new Error('Invalid release version');
	const lines = changelog.split(/\r?\n/);
	const start = lines.findIndex(line => {
		const text = line.trim();
		if (!text.startsWith(`## ${version}`)) return false;
		// The version ends at a space or the line end, so 1.1.3 never picks up the 1.1.3-rc.1 section.
		return /^(\s|$)/.test(text.slice(3 + version.length));
	});
	if (start === -1) return null;
	const body = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('## ')) break;
		body.push(line);
	}
	return body.join('\n').trim() || null;
}

/** Read the owning GitHub repository from the published metadata, never from a hardcoded name. */
export function repositorySlug(metadata) {
	const raw = typeof metadata?.repository === 'string' ? metadata.repository : metadata?.repository?.url;
	const url = String(raw ?? '').trim();
	const shorthand = /^github:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url);
	if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };
	const match = /github\.com[/:]([^/]+)\/([^/.#]+?)(?:\.git)?\/?$/i.exec(url.replace(/#.*$/, ''));
	if (!match) throw new Error('Published package does not declare a GitHub repository');
	return { owner: match[1], repo: match[2] };
}

/** Notes read at the published commit belong to exactly the bytes npm published. */
export async function fetchReleaseNotes({ metadata, version, fetchImpl = fetch }) {
	let source = 'unavailable';
	try {
		const { owner, repo } = repositorySlug(metadata);
		const commit = metadata?.gitHead;
		if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Published package does not declare a commit');
		source = `${owner}/${repo}@${commit.slice(0, 7)} CHANGELOG.md`;
		const response = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/CHANGELOG.md`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
		if (!response.ok) throw new Error('Changelog unavailable');
		const section = releaseNotesSection(await response.text(), version);
		if (!section) throw new Error('Changelog has no section for this version');
		const notes = Buffer.from(section, 'utf8').subarray(0, MAX_NOTES_BYTES).toString('utf8');
		return { notes, notesSource: source.slice(0, MAX_SOURCE_BYTES) };
	} catch {
		// An explicit marker beats a silently empty description; the interface localizes the
		// fallback text and shows where the notes would have come from.
		return { notes: '', notesSource: `unavailable (${source})`.slice(0, MAX_SOURCE_BYTES) };
	}
}
