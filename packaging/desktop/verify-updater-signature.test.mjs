import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes, createHash } from 'node:crypto';
import { verifyUpdaterSignature } from './verify-updater-signature.mjs';

const b64 = buffer => buffer.toString('base64');
function publicKeyText(body, keyId, algorithm = 'Ed') {
	return b64(Buffer.from(`untrusted comment: minisign public key: ${keyId}\n${b64(Buffer.concat([Buffer.from(algorithm), Buffer.from(keyId, 'hex'), body]))}\n`));
}
function signatureText(signature, keyId, algorithm = 'Ed') {
	return b64(Buffer.from(`untrusted comment: signature from tauri secret key\n${b64(Buffer.concat([Buffer.from(algorithm), Buffer.from(keyId, 'hex'), signature]))}\n`));
}
function pair(algorithm = 'Ed') {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const body = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
	const keyId = randomBytes(8).toString('hex');
	const artifact = randomBytes(1024);
	const message = algorithm === 'ED' ? createHash('blake2b512').update(artifact).digest() : artifact;
	const raw = sign(null, message, privateKey);
	return { artifact, publicKey: publicKeyText(body, keyId, algorithm), signature: signatureText(raw, keyId, algorithm), raw, keyId };
}

test('a signature made by the configured key verifies', () => {
	const { artifact, publicKey, signature, keyId } = pair();
	assert.equal(verifyUpdaterSignature({ artifact, signatureBase64: signature, publicKeyBase64: publicKey }), keyId);
	const prehashed = pair('ED');
	assert.ok(verifyUpdaterSignature({ artifact: prehashed.artifact, signatureBase64: prehashed.signature, publicKeyBase64: prehashed.publicKey }));
});

test('a signature from another key, a changed artifact or a mismatched id is refused', () => {
	const { artifact, publicKey, signature } = pair();
	const other = pair();
	assert.throws(() => verifyUpdaterSignature({ artifact, signatureBase64: other.signature, publicKeyBase64: publicKey }), /different key/);
	assert.throws(() => verifyUpdaterSignature({ artifact: randomBytes(1024), signatureBase64: signature, publicKeyBase64: publicKey }), /does not match/);
	const mismatched = signatureText(other.raw, pair().keyId);
	assert.throws(() => verifyUpdaterSignature({ artifact, signatureBase64: mismatched, publicKeyBase64: publicKey }), /different key/);
});
