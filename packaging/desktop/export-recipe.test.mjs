import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPackageRoot } from './export-recipe.mjs';
test('export uses coding-agent nested core, not a different root dependency',()=>{
 const root=mkdtempSync(join(tmpdir(),'jouzu-export-'));
 const coding=join(root,'node_modules/@earendil-works/pi-coding-agent');
 const nested=join(coding,'node_modules/@earendil-works/pi-agent-core');
 const top=join(root,'node_modules/@earendil-works/pi-agent-core');
 try{
  for(const [path,name] of [[coding,'@earendil-works/pi-coding-agent'],[nested,'@earendil-works/pi-agent-core'],[top,'@earendil-works/pi-agent-core']]){
   mkdirSync(path,{recursive:true});writeFileSync(join(path,'package.json'),JSON.stringify({name}));
  }
  assert.equal(exportPackageRoot(root,'@earendil-works/pi-agent-core'),realpathSync(nested));
  rmSync(nested,{recursive:true});
  assert.equal(exportPackageRoot(root,'@earendil-works/pi-agent-core'),realpathSync(top));
 }finally{rmSync(root,{recursive:true,force:true});}
});
