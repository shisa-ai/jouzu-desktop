import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pruneUpdates} from './prune-updates.mjs';
test('repeated updates retain only current and one rollback, no store or abandoned stage',()=>{
 const root=mkdtempSync(join(tmpdir(),'jouzu-prune-'));try{
 mkdirSync(join(root,'versions'));
 for(let i=0;i<5;i++){
  mkdirSync(join(root,'versions',`v${i}`));mkdirSync(join(root,'store'));mkdirSync(join(root,'recipe-abc'));
  writeFileSync(join(root,'active.json'),JSON.stringify({schemaVersion:1,slot:`v${i}`}));
  writeFileSync(join(root,'previous.json'),JSON.stringify(i?{schemaVersion:1,slot:`v${i-1}`}:null));
  pruneUpdates(root);assert.equal(readdirSync(join(root,'versions')).length,i?2:1);assert.equal(existsSync(join(root,'store')),false);assert.equal(existsSync(join(root,'recipe-abc')),false);
 }
 writeFileSync(join(root,'active.json'),'bad');assert.throws(()=>pruneUpdates(root));assert.equal(readdirSync(join(root,'versions')).length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
