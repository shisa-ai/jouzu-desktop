import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJouzuUpdate } from './install-update.mjs';

function fixture(t, overrides = {}) {
 const managed = mkdtempSync(join(tmpdir(), 'jouzu-install-result-'));
 t.after(() => rmSync(managed, {recursive:true, force:true}));
 const events = [];
 const options = {managed, runtime:managed, version:'0.1.18', onProgress:event=>events.push(event)};
 const dependencies = {
  download:async()=>({recipe:managed}), stage:async()=>{},
  activate:async()=>({version:'0.1.18'}), prune:()=>{}, ...overrides,
 };
 return {managed, events, options, dependencies};
}

test('cleanup failure preserves successful activation and allows a later retry', async t => {
 let calls = 0;
 const f = fixture(t, {prune:()=>{if (++calls === 2) throw Error('locked file');}});
 const result = await installJouzuUpdate(f.options, f.dependencies);
 assert.equal(result.version, '0.1.18');
 assert.equal(result.cleanupPending, true);
 assert.equal(f.events.at(-1).cleanupPending, true);
 assert.equal(existsSync(join(f.managed,'updates/operation.lock')), false);
 const retried = await installJouzuUpdate(f.options, f.dependencies);
 assert.equal(retried.cleanupPending, false);
});

test('cleanup does not replace the original installation error', async t => {
 const primary = Error('download failed');
 let calls = 0;
 const f = fixture(t, {
  download:async()=>{throw primary;},
  prune:()=>{if (++calls === 2) throw Error('cleanup failed');},
 });
 await assert.rejects(installJouzuUpdate(f.options,f.dependencies), error=>error===primary);
 assert.equal(f.events.some(event=>event.phase==='complete'),false);
 assert.equal(existsSync(join(f.managed,'updates/operation.lock')),false);
});

test('failed preflight cleanup prevents further storage growth', async t => {
 let downloaded = false;
 const f = fixture(t, {prune:()=>{throw Error('cleanup blocked');},download:async()=>{downloaded=true;}});
 await assert.rejects(installJouzuUpdate(f.options,f.dependencies),/cleanup blocked/);
 assert.equal(downloaded,false);
});

test('completion is emitted after cleanup finishes', async t => {
 let cleaned = false, calls = 0;
 const f = fixture(t,{prune:()=>{if(++calls===2) cleaned=true;}});
 f.options.onProgress = event=>{if(event.phase==='complete') assert.equal(cleaned,true);};
 const result = await installJouzuUpdate(f.options,f.dependencies);
 assert.equal(result.cleanupPending,false);
});
