import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activateJouzu,rollbackJouzu,withUpdateLock} from './activate-update.mjs';
function fixture(){
 const managed=mkdtempSync(join(tmpdir(),'jouzu-activation-'));
 for(const [slot,version]of [['old','0.1.17'],['new','0.1.18']]){
  const app=join(managed,'updates/versions',slot,'app');mkdirSync(join(app,'node_modules/jouzu/dist'),{recursive:true});
  writeFileSync(join(app,'bootstrap.mjs'),'fixture');writeFileSync(join(app,'node_modules/jouzu/dist/cli.js'),'fixture');
  writeFileSync(join(app,'node_modules/jouzu/package.json'),JSON.stringify({name:'jouzu',version}));
 }
 return managed;
}
const healthCheck=async()=>{};
test('activate and rollback retain old files and exact selection',async()=>{
 const managed=fixture();
 try{
  await activateJouzu({managed,slot:'old',version:'0.1.17',healthCheck});
  await activateJouzu({managed,slot:'new',version:'0.1.18',healthCheck});
  const active=()=>JSON.parse(readFileSync(join(managed,'updates/active.json'),'utf8'));
  assert.equal(active().version,'0.1.18');
  await rollbackJouzu({managed,healthCheck});assert.equal(active().version,'0.1.17');
  assert.ok(existsSync(join(managed,'updates/versions/new/app/bootstrap.mjs')));
 }finally{rmSync(managed,{recursive:true,force:true});}
});
test('unhealthy target or mismatched version leaves previous active unchanged',async()=>{
 const managed=fixture();try{
  await activateJouzu({managed,slot:'old',version:'0.1.17',healthCheck});
  const path=join(managed,'updates/active.json');const before=readFileSync(path);
  await assert.rejects(activateJouzu({managed,slot:'new',version:'0.1.18',healthCheck:async()=>{throw Error('startup failed');}}),/startup/);
  await assert.rejects(activateJouzu({managed,slot:'new',version:'0.1.19',healthCheck}),/mismatched/);
  await assert.rejects(activateJouzu({managed,slot:'../escape',version:'0.1.18',healthCheck}),/Invalid/);
  assert.deepEqual(readFileSync(path),before);assert.equal(existsSync(join(managed,'updates/operation.lock')),false);
 }finally{rmSync(managed,{recursive:true,force:true});}
});
test('parallel writers and stale lock are refused, not silently stolen',async()=>{
 const managed=fixture();try{
  await withUpdateLock(managed,async()=>{await assert.rejects(activateJouzu({managed,slot:'new',version:'0.1.18',healthCheck}),/requires recovery/);});
  writeFileSync(join(managed,'updates/operation.lock'),'crash fixture');
  await assert.rejects(activateJouzu({managed,slot:'new',version:'0.1.18',healthCheck}),/requires recovery/);
 }finally{rmSync(managed,{recursive:true,force:true});}
});
test('rollback to bundled requires health check and removes only pointer',async()=>{
 const managed=fixture();try{
  await activateJouzu({managed,slot:'new',version:'0.1.18',healthCheck});
  let checked=false;
  await rollbackJouzu({managed,healthCheck:async app=>{assert.equal(app,null);checked=true;}});
  assert.ok(checked);assert.equal(existsSync(join(managed,'updates/active.json')),false);
  assert.ok(existsSync(join(managed,'updates/versions/new/app/bootstrap.mjs')));
 }finally{rmSync(managed,{recursive:true,force:true});}
});
