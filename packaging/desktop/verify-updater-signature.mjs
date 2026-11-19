import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The updater signature must be verifiable by the key the installed app carries. The CI
// signing key is a secret and cannot be inspected, so the release proves the pairing instead:
// this verifies the signature over the exact artifact bytes with the configured public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function minisignBlob(encoded, what) {
	const text = Buffer.from(String(encoded).trim(), 'base64').toString('utf8');
	const line = text.split(/\r?\n/).find(value => value && !value.startsWith('untrusted comment'));
	if (!line) throw new Error(`Invalid ${what}`);
	const raw = Buffer.from(line, 'base64');
	if (raw.length < 10) throw new Error(`Invalid ${what}`);
	const algorithm = raw.subarray(0, 2).toString();
	if (algorithm !== 'Ed' && algorithm !== 'ED') throw new Error(`Unsupported ${what} algorithm`);
	return { algorithm, keyId: raw.subarray(2, 10).toString('hex'), body: raw.subarray(10) };
}

/** Verify an updater signature against the public key the released app embeds. */
export function verifyUpdaterSignature({ artifact, signatureBase64, publicKeyBase64 }) {
	const key = minisignBlob(publicKeyBase64, 'public key');
	if (key.body.length !== 32) throw new Error('Invalid public key length');
	const signature = minisignBlob(signatureBase64, 'signature');
	if (signature.body.length !== 64) throw new Error('Invalid signature length');
	if (signature.keyId !== key.keyId) throw new Error('Signature was made by a different key');
	// minisign's legacy mode signs the bytes; prehashed mode signs their BLAKE2b-512 digest.
	const message = signature.algorithm === 'ED' ? createHash('blake2b512').update(artifact).digest() : artifact;
	const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key.body]), format: 'der', type: 'spki' });
	if (!verify(null, message, publicKey, signature.body)) throw new Error('Signature does not match the artifact');
	return signature.keyId;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [artifactPath, signaturePath, publicKey] = process.argv.slice(2);
	if (!artifactPath || !signaturePath || !publicKey) throw new Error('Usage: node verify-updater-signature.mjs <artifact> <signature> <public-key-base64>');
	const keyId = verifyUpdaterSignature({ artifact: readFileSync(artifactPath), signatureBase64: readFileSync(signaturePath, 'utf8'), publicKeyBase64: publicKey });
	process.stdout.write(`Updater signature verifies with the app public key (key ${keyId})\n`);
}
