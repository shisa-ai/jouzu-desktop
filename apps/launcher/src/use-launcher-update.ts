import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createUpdateSchedule, startUpdateChecks } from "./update-schedule";
import { logEvent } from "./log-event";

/** The feed this installation follows. QA is the same installation and data on a second feed. */
export type UpdateChannel = "stable" | "qa";

interface Offer { version: string; notes: string | null; downgrade: boolean; channel: UpdateChannel }
interface Progress { downloaded: number; total: number | null }

export function useLauncherUpdate(configured: boolean, enabled = true) {
 const [version,setVersion]=useState<string|null>(null);
 const [notes,setNotes]=useState<string|null>(null);
 const [downgrade,setDowngrade]=useState(false);
 const [channel,setChannelState]=useState<UpdateChannel|null>(null);
 const [phase,setPhase]=useState<"idle"|"checking"|"current"|"available"|"downloading"|"installing"|"error">("idle");
 const [progress,setProgress]=useState<number|undefined>();
 const [error,setError]=useState<string|null>(null);
 const lock=useRef(false);
 useEffect(()=>{ if(!configured)return; void invoke<UpdateChannel>("update_channel").then(setChannelState).catch(()=>setChannelState("stable")); },[configured]);
 // A silent check runs on its own schedule and must not move the interface while it asks.
 async function refresh(silent=false) {
  if(!configured || !enabled || lock.current)return;
  lock.current=true;if(!silent){setError(null);setPhase("checking");}
  try {
   setVersion(null);setNotes(null);setDowngrade(false);
   const offer=await invoke<Offer|null>("update_check");
   setVersion(offer?.version ?? null);setNotes(offer?.notes ?? null);setDowngrade(!!offer?.downgrade);setPhase(offer ? "available":"current");
   logEvent(offer ? `launcher update check result=available version=${offer.version} channel=${offer.channel} downgrade=${offer.downgrade}` : "launcher update check result=current");
  }catch(e){logEvent(`launcher update check failed error=${String(e)}`);if(!silent){setError(String(e));setPhase("error");}}finally{lock.current=false;}
 }
 async function install() {
  if(!version || lock.current)return;
  lock.current=true;setError(null);setProgress(undefined);setPhase("downloading");
  logEvent(`launcher update installing version=${version}`);
  const stop=await listen<Progress>("launcher-update-progress",event=>{
   const {downloaded,total}=event.payload;
   if(total)setProgress(Math.min(100,downloaded/total*100));
   if(total && downloaded>=total)setPhase("installing");
  });
  try { await invoke("update_install"); }
  catch(e){logEvent(`launcher update install failed error=${String(e)}`);setError(String(e));setPhase("error");}
  finally{stop();lock.current=false;}
 }
 /** Follow another feed. The next check answers from it; nothing is installed until asked. */
 async function setChannel(next: UpdateChannel) {
  if(lock.current)return;
  try { setChannelState(await invoke<UpdateChannel>("update_channel_set",{channel:next})); logEvent(`launcher update channel=${next}`); await refresh(); }
  catch(e){setError(String(e));setPhase("error");}
 }
 // The schedule lives for the whole session, so it reads the current refresh through a ref: the first
 // render happens before the configuration arrives, and a captured refresh would answer from it.
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 const schedule=useRef(createUpdateSchedule(silent=>{void refreshRef.current(silent);}));
 useEffect(()=>{ if(!configured || !enabled)return; return startUpdateChecks(schedule.current); },[configured,enabled]);
 return {version,notes,downgrade,channel,setChannel,phase,progress,error,refresh:()=>refresh(),install,busy:phase==="checking"||phase==="downloading"||phase==="installing"};
}
