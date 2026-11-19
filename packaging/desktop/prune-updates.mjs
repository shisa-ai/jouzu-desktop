import {existsSync,readFileSync,readdirSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

/** Called under the updater lock with application sessions quiescent.
 * Keep active plus ONE rollback slot; never guess from a corrupt receipt.
 */
export function pruneUpdates(root) {
 const keep=new Set();
 for(const name of ['active.json','previous.json']){
  const path=join(root,name);if(!existsSync(path))continue;
  const value=JSON.parse(readFileSync(path,'utf8'));
  if(value===null && name==='previous.json')continue;
  if(value?.schemaVersion!==1 || typeof value.slot!=='string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.slot))throw Error('Invalid update receipt; cleanup stopped');
  keep.add(value.slot);
 }
 const slots=join(root,'versions');
 if(existsSync(slots))for(const name of readdirSync(slots)){
  if(keep.has(name))continue;
  const path=join(slots,name);
  if(lstatSync(path).isSymbolicLink())throw Error('Unexpected link in update storage');
  rmSync(path,{recursive:true,force:true});
 }
 // Cache is expendable, not a second permanent installation store.
 rmSync(join(root,'store'),{recursive:true,force:true});
 for(const name of readdirSync(root))if(/^recipe-[a-f0-9-]+(?:\.download-[a-f0-9-]+)?$/.test(name))rmSync(join(root,name),{recursive:true,force:true});
}
