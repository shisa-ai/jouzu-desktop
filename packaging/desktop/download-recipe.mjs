import { fetchUpdateFile, recipeFileUrl } from './update-transport.mjs';
import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authenticateRecipe, verifyRecipeFile } from './authenticate-recipe.mjs';

async function boundedDownload(url, maxBytes, signal) {
 const response = await fetchUpdateFile(url, {signal});
 if (!response.ok || !response.body) throw new Error('Update download failed');
 const length=response.headers.get('content-length');
 if(length !== null && (!/^\d+$/.test(length) || Number(length)>maxBytes)) throw new Error('Update download exceeds size limit');
 const reader=response.body.getReader(); const chunks=[]; let size=0;
 try {
  for (;;) {
   const {done,value}=await reader.read(); if(done)break;
   size+=value.length;
   if(size>maxBytes)throw new Error('Update download exceeds size limit');
   chunks.push(value);
  }
 } finally { await reader.cancel(); }
 return Buffer.concat(chunks,size);
}

/** Download only signed, enumerated files. No archive extraction or active mutation.
 * URL and public key must be app-owned configuration, not renderer input.
 */
export async function downloadRecipe({url,publicKey,expected,destination,signal,allowLoopbackHttp=false,allowTestHttpHost=null,onProgress=()=>{}}) {
 const source=new URL(url);
 if(source.username || source.password || source.search || source.hash || !source.pathname.endsWith('/'))throw new Error('Invalid recipe base URL');
 if(source.protocol!=='https:' && !(source.protocol==='http:' && ((allowLoopbackHttp && ['127.0.0.1','[::1]'].includes(source.hostname)) || (allowTestHttpHost && source.hostname===allowTestHttpHost))))throw new Error('Recipe requires HTTPS');
 const output=resolve(destination);
 if(existsSync(output))throw new Error('Recipe destination already exists');
 const timeout=AbortSignal.timeout(10*60*1000);
 const combined=signal ? AbortSignal.any([signal,timeout]) : timeout;
 const bytes=await boundedDownload(recipeFileUrl(source,'manifest.json'),1024*1024,combined);
 const signature=await boundedDownload(recipeFileUrl(source,'manifest.sig'),64,combined);
 const manifest=authenticateRecipe(bytes,signature,publicKey,expected);
 const temporary=`${output}.download-${randomUUID()}`;
 mkdirSync(temporary);
 try {
  let downloaded=0;const total=manifest.files.reduce((sum,file)=>sum+file.size,0);
  onProgress({phase:'downloading',downloaded,total});
  for(const file of manifest.files) {
   combined.throwIfAborted();
   const bytes=await boundedDownload(recipeFileUrl(source,file.path),file.size,combined);
   verifyRecipeFile(bytes,file);
   const target=join(temporary,file.path);mkdirSync(dirname(target),{recursive:true});
   writeFileSync(target,bytes,{flag:'wx'});
   downloaded+=bytes.length;onProgress({phase:'downloading',downloaded,total});
  }
  combined.throwIfAborted();renameSync(temporary,output);
  return {recipe:output,manifest};
 }finally{rmSync(temporary,{recursive:true,force:true});}
}
