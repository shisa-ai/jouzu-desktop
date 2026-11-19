import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createUpdateSchedule, startUpdateChecks } from './update-schedule';
import { logEvent } from './log-event';
export function useJouzuUpdate(configured:boolean, onInstalled:()=>void, enabled = true) {
 const [version,setVersion]=useState<string|null>(null);
 const [notes,setNotes]=useState<string|null>(null);
 const [notesSource,setNotesSource]=useState<string|null>(null);
 const [phase,setPhase]=useState('idle');
 const [error,setError]=useState<string|null>(null);
 const [progress,setProgress]=useState<number|undefined>();
 const lock=useRef(false);
 useEffect(()=>{if(!enabled)return;const event=listen<{phase:string;downloaded?:number;total?:number}>('jouzu-update-progress',({payload})=>{
  if(!lock.current)return;
  setPhase(payload.phase);setProgress(payload.total ? (payload.downloaded??0)/payload.total*100:undefined);
 });return ()=>{void event.then(unlisten=>unlisten()).catch(()=>{});};},[]);
 // A silent check runs on its own schedule and must not move the interface while it asks.
 async function run(action:'check'|'install', silent=false) {
  if(!configured || !enabled || lock.current)return;lock.current=true;
  if(!silent){setError(null);setPhase(action==='check'?'checking':'downloading');}
  try{
   const result=await invoke<{version:string;available:boolean;notes?:string;notesSource?:string}>('jouzu_update',{action,version:action==='install'?version:null});
   if(action==='check'){setVersion(result.available?result.version:null);setNotes(result.notes??null);setNotesSource(result.notesSource??null);setPhase(result.available?'available':'current');}
   else{setVersion(null);setPhase('complete');onInstalled();}
  }catch(e){logEvent(`jouzu update check failed error=${String(e)}`);if(!silent){setError(String(e));setPhase('error');}}finally{lock.current=false;}
 }
 // The schedule lives for the whole session, so it reads the current run through a ref: the first
 // render happens before the configuration arrives, and a captured run would answer from it.
 const runRef=useRef(run);runRef.current=run;
 const schedule=useRef(createUpdateSchedule(silent=>{void runRef.current('check',silent);}));
 useEffect(()=>{if(!configured || !enabled)return;return startUpdateChecks(schedule.current);},[configured,enabled]);
 return {version,notes,notesSource,phase,error,progress,busy:!['idle','available','current','complete','error'].includes(phase),check:()=>run('check'),install:()=>run('install')};
}

