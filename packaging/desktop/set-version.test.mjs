import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setVersion } from './set-version.mjs';

function tree(version) {
	const root = mkdtempSync(join(tmpdir(), 'set-version-'));
	const tauri = join(root, 'apps', 'desktop', 'src-tauri');
	mkdirSync(tauri, { recursive: true });
	writeFileSync(join(root, 'apps', 'desktop', 'package.json'), `{\n  "name": "desktop",\n  "version": "${version}",\n  "private": true\n}\n`);
	writeFileSync(join(tauri, 'Cargo.toml'), `[package]\nname = "jouzu-desktop"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`);
	writeFileSync(join(tauri, 'Cargo.lock'), `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "jouzu-desktop"\nversion = "${version}"\n`);
	return root;
}

// #86: the stable build is X.Y.Z, made from the commit of X.Y.Z-rc.N.
test('sets the version in package.json, Cargo.toml and Cargo.lock only', () => {
	const root = tree('1.1.3-rc.2');
	setVersion(root, '1.1.3');
	const tauri = join(root, 'apps', 'desktop', 'src-tauri');
	assert.match(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'), /"version": "1.1.3"/);
	const manifest = readFileSync(join(tauri, 'Cargo.toml'), 'utf8');
	assert.match(manifest, /^version = "1.1.3"$/m);
	assert.match(manifest, /serde = \{ version = "1" \}/, 'dependency versions are untouched');
	const lock = readFileSync(join(tauri, 'Cargo.lock'), 'utf8');
	assert.match(lock, /name = "jouzu-desktop"\nversion = "1.1.3"/);
	assert.match(lock, /name = "serde"\nversion = "1.0.0"/);
});

test('refuses a version that is not a release version', () => {
	assert.throws(() => setVersion(tree('1.1.3-rc.2'), '1.1'), /Not a release version/);
});
