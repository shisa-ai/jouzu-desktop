import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync,sign,createHash } from 'node:crypto';
import { mkdtempSync,rmSync,existsSync,readdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadRecipe } from './download-recipe.mjs';
for(const mode of ['valid','tamper','bad-signature','oversize','redirect','cancel'])test(`signed recipe HTTP fixture ${mode}`,async()=>{
 const keys=generateKeyPairSync('ed25519');const body=Buffer.from('fixture');
 const manifest={schemaVersion:1,platform:'win32',arch:'x64',version:'0.1.18',files:['package.json','pnpm-lock.yaml'].map(path=>({path,size:body.length,sha256:createHash('sha256').update(body).digest('hex')}))};
 const bytes=Buffer.from(JSON.stringify(manifest));let signature=sign(null,bytes,keys.privateKey);if(mode==='bad-signature')signature=Buffer.alloc(64);
 const requests=[];
 const server=createServer((req,res)=>{
  requests.push(req.url);
  if(req.url==='/manifest.json'){res.end(bytes);return;}
  if(req.url==='/manifest.sig'){res.end(signature);return;}
  if(mode==='redirect'){res.writeHead(302,{Location:'/other'}).end();return;}
  if(mode==='oversize'){res.end(Buffer.alloc(100));return;}
  res.end(mode==='tamper'?Buffer.from('changed'):body);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=mkdtempSync(join(tmpdir(),'jouzu-recipe-download-'));const destination=join(root,'recipe');
 const controller=new AbortController();if(mode==='cancel')controller.abort();
 try{
  const operation=downloadRecipe({url:`http://127.0.0.1:${server.address().port}/`,publicKey:keys.publicKey.export({type:'spki',format:'pem'}),expected:{platform:'win32',arch:'x64',version:'0.1.18',maxBytes:100},destination,allowLoopbackHttp:true,signal:controller.signal});
  if(mode==='valid'){await operation;assert.deepEqual(readFileSync(join(destination,'package.json')),body);}
  else {await assert.rejects(operation);assert.equal(existsSync(destination),false);}
  if(mode==='bad-signature')assert.deepEqual(requests,['/manifest.json','/manifest.sig']);
  assert.equal(readdirSync(root).some(name=>name.includes('.download-')),false);
 }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});rmSync(root,{recursive:true,force:true});}
});
