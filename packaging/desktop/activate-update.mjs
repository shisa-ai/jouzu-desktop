import { openSync,closeSync,fsyncSync,writeFileSync,readFileSync,renameSync,rmSync,mkdirSync,realpathSync,existsSync } from 'node:fs';
import { join,relative,isAbsolute,sep } from 'node:path';
import { randomUUID } from 'node:crypto';

function atomicWrite(path, bytes) {
 const temporary=`${path}.${randomUUID()}.tmp`;
 let descriptor;
 try {
  descriptor=openSync(temporary,'wx',0o600);
  writeFileSync(descriptor,bytes);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
  renameSync(temporary,path);
 }finally{if(descriptor!==undefined)closeSync(descriptor);rmSync(temporary,{force:true});}
}
function readOptional(path) {
 try{return readFileSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

/** All update writers must hold this lock. A crashed writer leaves an explicit
 * recovery requirement; never steal an old lock based on time or a reused PID.
 */
export async function withUpdateLock(managed, operation) {
 const root=join(managed,'updates');mkdirSync(root,{recursive:true});
 const lock=join(root,'operation.lock');
 let descriptor;
 try {descriptor=openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('Another update or interrupted update requires recovery');throw error;}
 try {writeFileSync(descriptor,JSON.stringify({pid:process.pid}));fsyncSync(descriptor);return await operation(root);}
 finally {closeSync(descriptor);rmSync(lock,{force:true});}
}

const transactionTokens = new WeakSet();
export async function withUpdateTransaction(managed, operation) {
 return withUpdateLock(managed,async root=>{
  const token={root};transactionTokens.add(token);
  try{return await operation(token);}finally{transactionTokens.delete(token);}
 });
}

function validateSlot(root,selection) {
 if(selection.schemaVersion!==1 || typeof selection.slot!=='string' || !/^[a-zA-Z0-9-]{1,100}$/.test(selection.slot)
  || typeof selection.version!=='string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selection.version))throw new Error('Invalid version selection');
 const slots=realpathSync(join(root,'versions'));
 const app=realpathSync(join(slots,selection.slot,'app'));
 const rel=relative(slots,app);
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('Version slot escapes storage');
 const packageInfo=JSON.parse(readFileSync(join(app,'node_modules/jouzu/package.json'),'utf8'));
 if(packageInfo.name!=='jouzu'||packageInfo.version!==selection.version||!existsSync(join(app,'bootstrap.mjs'))||!existsSync(join(app,'node_modules/jouzu/dist/cli.js')))throw new Error('Version slot incomplete or mismatched');
 return app;
}

/** The caller supplies a real target/runtime/startup health check; no default
 * success check is allowed. Selected/previous slots are never deleted here.
 */
export async function activateJouzu({managed,slot,version,healthCheck}, transaction) {
 if(typeof healthCheck!=='function')throw new Error('Activation health check required');
 const activate = async root=>{
  const selection={schemaVersion:1,slot,version};
  const app=validateSlot(root,selection);
  await healthCheck(app,version);
  const active=join(root,'active.json');const previous=readOptional(active);
  if(previous){validateSlot(root,JSON.parse(previous.toString('utf8')));atomicWrite(join(root,'previous.json'),previous);}
  else atomicWrite(join(root,'previous.json'),Buffer.from('null'));
  atomicWrite(active,Buffer.from(JSON.stringify(selection)+'\n'));
  return {app,version};
 };
 if(transaction) {
  if(transaction.root !== join(managed,'updates') || !transactionTokens.has(transaction))throw new Error('Invalid update transaction');
  return activate(transaction.root);
 }
 return withUpdateLock(managed,activate);
}

export async function rollbackJouzu({managed,healthCheck}) {
 if(typeof healthCheck!=='function')throw new Error('Rollback health check required');
 return withUpdateLock(managed,async root=>{
  const previous=readOptional(join(root,'previous.json'));
  if(!previous)throw new Error('No rollback record');
  const selection=JSON.parse(previous.toString('utf8'));
  // Bundled fallback needs an explicit caller check too.
  const app=selection===null?null:validateSlot(root,selection);
  await healthCheck(app,selection?.version);
  if(selection===null)rmSync(join(root,'active.json'),{force:true});
  else atomicWrite(join(root,'active.json'),previous);
  return {app,version:selection?.version??null};
 });
}
