import { createHash, verify, createPublicKey } from 'node:crypto';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 4096;
const MAX_NOTES_BYTES = 8192;
const MAX_SOURCE_BYTES = 256;

/** Verify the exact manifest bytes before parsing any update-controlled paths.
 * Public keys come from app configuration, never from the update response.
 * Each signed file digest covers the bytes subsequently supplied to pnpm.
 */
export function authenticateRecipe(bytes, signature, publicKey, expected) {
 if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST_BYTES) throw new Error('Invalid recipe manifest size');
 const key = createPublicKey(publicKey);
 if (key.asymmetricKeyType !== 'ed25519') throw new Error('Recipe requires an Ed25519 key');
 if (!Buffer.isBuffer(signature) || signature.length !== 64 || !verify(null, bytes, key, signature)) throw new Error('Recipe signature rejected');
 const manifest = JSON.parse(bytes.toString('utf8'));
 if (manifest.schemaVersion !== 1 || manifest.platform !== expected.platform || manifest.arch !== expected.arch || manifest.version !== expected.version) throw new Error('Recipe target mismatch');
 if (manifest.notes !== undefined && (typeof manifest.notes !== 'string' || Buffer.byteLength(manifest.notes, 'utf8') > MAX_NOTES_BYTES)) throw new Error('Invalid recipe notes');
 if (manifest.notesSource !== undefined && (typeof manifest.notesSource !== 'string' || Buffer.byteLength(manifest.notesSource, 'utf8') > MAX_SOURCE_BYTES)) throw new Error('Invalid recipe notes source');
 if (!Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > MAX_FILES) throw new Error('Invalid recipe file list');
 const names = new Set();
 let total = 0;
 for (const file of manifest.files) {
  // Flat artifact/patch names exclude traversal, URLs, Windows ADS, device names,
  // case collisions and pnpm config files that could enable lifecycle scripts.
  if (!file || typeof file.path !== 'string' || !/^(package\.json|pnpm-lock\.yaml|(?:artifacts|patches)\/[a-zA-Z0-9_@][a-zA-Z0-9_.@+-]*)$/.test(file.path)) throw new Error('Unsafe recipe path');
  const leaf = file.path.split('/').at(-1);
  if (leaf.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf)) throw new Error('Unsafe recipe path');
  const folded = file.path.toLowerCase();
  if (names.has(folded)) throw new Error('Duplicate recipe path');
  names.add(folded);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid recipe file digest');
  total += file.size;
  if (!Number.isSafeInteger(total) || total > expected.maxBytes) throw new Error('Recipe exceeds size limit');
 }
 if (!Number.isSafeInteger(expected.maxBytes) || expected.maxBytes < 1) throw new Error('Recipe size limit required');
 if (!names.has('package.json') || !names.has('pnpm-lock.yaml')) throw new Error('Incomplete recipe');
 return manifest;
}

export function verifyRecipeFile(bytes, file) {
 if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Recipe file integrity rejected');
}
