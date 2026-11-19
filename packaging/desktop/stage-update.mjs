import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installArguments, PNPM_VERSION } from './prepare-starter.mjs';
import { assertInstalledTarget } from './installed-target.mjs';
import { verifyRuntime } from './verify-runtime.mjs';

/** Stage only. The caller must authenticate the recipe before calling this function.
 * No active-directory mutation, activation, network release discovery or user-data writes.
 */
export async function stageJouzuUpdate({recipe, runtime, store, destination, target, signal, onProgress = () => {}}, dependencies = {}) {
 const run = dependencies.run ?? runPnpm;
 const verify = dependencies.verify ?? verifyRuntime;
 const targetCheck = dependencies.targetCheck ?? assertInstalledTarget;
 const output = resolve(destination);
 if (existsSync(output)) throw new Error('Update destination already exists');
 const manifest = JSON.parse(readFileSync(join(recipe,'package.json'),'utf8'));
 if (manifest.packageManager !== `pnpm@${PNPM_VERSION}` || !manifest.dependencies?.jouzu || manifest.scripts || manifest.workspaces) throw new Error('Invalid managed recipe');
 if (!existsSync(join(recipe,'pnpm-lock.yaml'))) throw new Error('Frozen release lockfile required');
 const temporary = `${output}.staging-${randomUUID()}`;
 mkdirSync(temporary);
 try {
  signal?.throwIfAborted();
  const app=join(temporary,'app');mkdirSync(app);
  for(const entry of ['package.json','pnpm-lock.yaml','artifacts','patches']) if(existsSync(join(recipe,entry))) cpSync(join(recipe,entry),join(app,entry),{recursive:true});
  onProgress({phase:'preparing'});
  const node=join(runtime,'node',process.platform==='win32'?'node.exe':'bin/node');
  const pnpm=join(runtime,'pnpm/bin/pnpm.cjs');
  const args=installArguments(app,resolve(store)).filter(arg=>arg!=='--offline');
  await run(node,[pnpm,...args,'--reporter=ndjson'],{signal,onProgress});
  signal?.throwIfAborted();onProgress({phase:'verifying'});
  targetCheck(app,target);
  await verify(app);
  if(!existsSync(join(app,'node_modules/jouzu/dist/cli.js')))throw new Error('Missing Jouzu entrypoint');
  // The app-owned bootstrap is part of every runnable app slot, not supplied
  // by a recipe. Copy only after the installed runtime has passed verification.
  cpSync(fileURLToPath(new URL('./bootstrap.mjs', import.meta.url)),join(app,'bootstrap.mjs'));
  signal?.throwIfAborted();
  renameSync(temporary,output);
  onProgress({phase:'staged'});
  return {app:join(output,'app')};
 } finally {rmSync(temporary,{recursive:true,force:true});}
}
function runPnpm(node,args,{signal,onProgress}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(node,args,{windowsHide:true,signal,env:{...process.env,CI:'true',JOUZU_NO_UPDATE:'1',PI_SKIP_VERSION_CHECK:'1'},stdio:['ignore','pipe','pipe']});
  // Drain output without returning registry URLs or arbitrary package logs to the UI.
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  const timer=setTimeout(()=>child.kill(),20*60*1000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Package preparation failed; current installation was not changed'));});
 });
}
