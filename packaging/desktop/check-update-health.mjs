import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstalledTarget } from './installed-target.mjs';

/** Probe only --version in a disposable home. Never start onboarding, use saved
 * provider credentials, or mutate the user's configuration to qualify a slot.
 */
export async function checkStagedHealth({node,app,version,signal}) {
 assertInstalledTarget(app);
 const home=mkdtempSync(join(tmpdir(),'jouzu-update-health-'));
 try{
  // Explicit environment allowlist avoids inheriting API keys and Node hooks.
  const env={JOUZU_HOME:home,JOUZU_NO_UPDATE:'1',PI_SKIP_VERSION_CHECK:'1',CI:'true'};
  for(const key of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATH','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
  await run(node,[fileURLToPath(new URL('./verify-runtime.mjs',import.meta.url)),app],env,signal);
  const output=await run(node,[join(app,'node_modules/jouzu/dist/cli.js'),'--version'],env,signal);
  if(!output.split(/\r?\n/).includes(`jouzu ${version}`))throw new Error('Jouzu startup version mismatch');
 }finally{rmSync(home,{recursive:true,force:true});}
}
function run(node,args,env,signal){
 return new Promise((resolve,reject)=>{
  const child=spawn(node,args,{env,signal,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';let exceeded=false;
  const timer=setTimeout(()=>child.kill(),30000);
  child.stdout.on('data',bytes=>{if(output.length+bytes.length>65536){exceeded=true;child.kill();}else output+=bytes.toString('utf8');});
  child.stderr.on('data',()=>{});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);code===0&&!exceeded?resolve(output):reject(new Error('Jouzu startup health check failed'));});
 });
}
