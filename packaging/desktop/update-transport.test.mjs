import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchUpdateFile,recipeFileUrl} from './update-transport.mjs';
const base=new URL('https://github.com/example/product/releases/download/jouzu-update/');
test('maps Release assets without changing ordinary directory sources',()=>{
 assert.equal(recipeFileUrl(base,'artifacts/jouzu.tgz').pathname,'/example/product/releases/download/jouzu-update/artifacts__jouzu.tgz');
 assert.equal(recipeFileUrl(new URL('https://example.com/feed/'),'artifacts/jouzu.tgz').pathname,'/feed/artifacts/jouzu.tgz');
});
test('permits bounded GitHub asset redirects',async()=>{
 const calls=[];
 const result=await fetchUpdateFile(new URL('manifest.json',base),{fetchImpl:async(url,options)=>{
  calls.push(String(url));assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
  return calls.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset?signature=fixture'}}):new Response('manifest');
 }});
 assert.equal(await result.text(),'manifest');assert.equal(calls.length,2);
});
test('rejects downgrade, unrelated hosts, credentials and redirect loops',async()=>{
 for(const location of ['http://release-assets.githubusercontent.com/asset','https://example.com/asset','https://user:secret@release-assets.githubusercontent.com/asset','https://release-assets.githubusercontent.com/asset']){
  let calls=0;
  await assert.rejects(fetchUpdateFile(new URL('manifest.json',base),{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}}),/redirect/);
  assert.ok(calls<=3);
 }
});
test('ordinary update sources cannot redirect into GitHub assets',async()=>{
 await assert.rejects(fetchUpdateFile('https://example.com/manifest.json',{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset'}})}),/redirect/);
});
