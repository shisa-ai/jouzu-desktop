import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { authenticateRecipe, verifyRecipeFile } from './authenticate-recipe.mjs';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({type:'spki',format:'pem'});
const content = Buffer.from('fixture');
const file = path => ({path,size:content.length,sha256:createHash('sha256').update(content).digest('hex')});
const base = () => ({schemaVersion:1,platform:'win32',arch:'x64',version:'0.1.18',files:[file('package.json'),file('pnpm-lock.yaml'),file('artifacts/jouzu-0.1.18.tgz')]});
const expected = {platform:'win32',arch:'x64',version:'0.1.18',maxBytes:1000};
function check(manifest, overrides={}) {
 const bytes=Buffer.from(JSON.stringify(manifest));
 return authenticateRecipe(bytes,sign(null,bytes,key.privateKey),publicKey,{...expected,...overrides});
}
test('authenticates exact target and all file digests',()=>{
 assert.deepEqual(check(base()),base());
 verifyRecipeFile(content,file('package.json'));
 assert.throws(()=>verifyRecipeFile(Buffer.from('changed'),file('package.json')),/integrity/);
});
test('rejects tampered manifest and unrelated signing key',()=>{
 const bytes=Buffer.from(JSON.stringify(base())); const signature=sign(null,bytes,key.privateKey);
 assert.throws(()=>authenticateRecipe(Buffer.concat([bytes,Buffer.from(' ')]),signature,publicKey,expected),/signature/);
 const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
 assert.throws(()=>authenticateRecipe(bytes,signature,other,expected),/signature/);
});
for(const path of ['../package.json','artifacts/../bad','artifacts/a:stream','artifacts/CON.tgz','artifacts/a.','/package.json','artifacts\\x','https://example.org/a','.npmrc']){
 test(`rejects unsafe signed path ${path}`,()=>{const m=base();m.files.push(file(path));assert.throws(()=>check(m),/Unsafe/);});
}
test('rejects duplicate paths, wrong targets, incomplete manifests and excessive sizes',()=>{
 const m=base();m.files.push(file('artifacts/JOUZU-0.1.18.tgz'));assert.throws(()=>check(m),/Duplicate/);
 for(const field of ['version','arch','platform'])assert.throws(()=>check(base(),{[field]:'wrong'}),/target/);
 assert.throws(()=>check({...base(),files:[file('package.json'),file('patches/a.patch')]}),/Incomplete/);
 assert.throws(()=>check(base(),{maxBytes:1}),/size limit/);
 assert.throws(()=>check(base(),{maxBytes:undefined}),/size limit/);
});

test('optional release notes are accepted and bounded',()=>{
 assert.equal(check({...base(),notes:'- A change.',notesSource:'source'}).notes,'- A change.');
 assert.throws(()=>check({...base(),notes:'x'.repeat(9000)}),/notes/);
 assert.throws(()=>check({...base(),notesSource:'x'.repeat(300)}),/notes source/);
 assert.throws(()=>check({...base(),notes:42}),/notes/);
});
