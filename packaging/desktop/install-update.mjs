import { pruneUpdates } from './prune-updates.mjs';
import { join } from 'node:path';
import { mkdirSync,rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { downloadRecipe } from './download-recipe.mjs';
import { stageJouzuUpdate } from './stage-update.mjs';
import { activateJouzu,withUpdateTransaction } from './activate-update.mjs';
import { checkStagedHealth } from './check-update-health.mjs';

/** A single process-owned lock spans download through activation. Caller config
 * (including expected release version) must come from a trusted release source.
 */
export async function installJouzuUpdate({managed,runtime,url,publicKey,version,signal,allowLoopbackHttp=false,allowTestHttpHost=null,onProgress=()=>{}}, dependencies = {}) {
 const prune = dependencies.prune ?? pruneUpdates;
 const download = dependencies.download ?? downloadRecipe;
 const stage = dependencies.stage ?? stageJouzuUpdate;
 const activate = dependencies.activate ?? activateJouzu;
 return withUpdateTransaction(managed,async transaction=>{
  prune(transaction.root);
  const slot=randomUUID();
  const versions=join(transaction.root,'versions');mkdirSync(versions,{recursive:true});
  const work=join(transaction.root,`recipe-${slot}`);
  let result;
  let cleanupPending = false;
  try{
   const {recipe}=await download({url,publicKey,expected:{version,platform:process.platform,arch:process.arch,maxBytes:512*1024*1024},destination:work,signal,allowLoopbackHttp,allowTestHttpHost,onProgress});
   await stage({recipe,runtime,store:join(transaction.root,'store'),destination:join(versions,slot),signal,onProgress});
   signal?.throwIfAborted();
   onProgress({phase:'verifying'});
   const node=join(runtime,'node',process.platform==='win32'?'node.exe':'bin/node');
   result=await activate({managed,slot,version,healthCheck:async app=>{
    await checkStagedHealth({node,app,version,signal});signal?.throwIfAborted();onProgress({phase:'activating'});
   }},transaction);
  } finally {
   // Cleanup cannot undo activation or replace the primary failure.
   try { rmSync(work,{recursive:true,force:true}); } catch { cleanupPending = true; }
   try { prune(transaction.root); } catch { cleanupPending = true; }
  }
  onProgress({phase:'complete',version,cleanupPending});
  return {...result,cleanupPending};
 });
}
