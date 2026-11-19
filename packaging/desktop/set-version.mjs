// Sets the desktop version in the three files that carry it: apps/desktop/package.json,
// src-tauri/Cargo.toml and the jouzu-desktop entry of src-tauri/Cargo.lock. The stable
// release workflow uses it to build X.Y.Z from the commit of X.Y.Z-rc.N (#86); the
// change is never committed.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion } from './release-guard.mjs';

export function setVersion(root, version) {
	parseVersion(version);
	const app = join(root, 'apps', 'desktop');
	const edit = (file, pattern, replacement) => {
		const text = readFileSync(file, 'utf8');
		const next = text.replace(pattern, replacement);
		if (next === text && !text.match(pattern)) throw new Error(`No version found in ${file}`);
		writeFileSync(file, next);
	};
	edit(join(app, 'package.json'), /("version":\s*")[^"]+(")/, `$1${version}$2`);
	edit(join(app, 'src-tauri', 'Cargo.toml'), /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
	edit(join(app, 'src-tauri', 'Cargo.lock'), /(name = "jouzu-desktop"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const version = process.argv[2];
	if (!version) throw new Error('Usage: node set-version.mjs <X.Y.Z or X.Y.Z-rc.N>');
	setVersion(resolve(fileURLToPath(import.meta.url), '..', '..', '..'), version);
	console.log(`version set to ${version}`);
}
