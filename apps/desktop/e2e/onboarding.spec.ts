import {test,expect,type Page} from '@playwright/test';
import { UI_BASE, stubHost, type HostStub, type Workspace } from './host-control';

// Drives the real onboarding surface through a stateful configuration backend behind the host API.
async function openSetup(page:Page, initial:{profile?:string|null;modelReady?:boolean;recent?:Workspace[]}={}) {
 await page.addInitScript(()=>{
  localStorage.setItem('jouzu.ui.language','en');
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1, unregisterCallback:()=>{},
   invoke:async (command:string)=>{
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 });
 const s={profile:initial.profile ?? null,modelReady:initial.modelReady ?? false,signedIn:initial.modelReady ?? false};
 const snapshot=()=>({schemaVersion:1,modelReady:s.modelReady,profile:s.profile,account:{signedIn:s.signedIn},credentials:[],customProviders:[],providers:[{id:'openai',name:'OpenAI'},{id:'openai-codex',name:'Codex',oauth:true,oauthName:'OpenAI (ChatGPT Plus/Pro)',apiKey:false}],models:[]});
 // A device sign-in shows its code and blocks until it settles or is cancelled, like the real backend.
 const deviceSignIn=(host:HostStub, device:Record<string,unknown>, done:()=>void)=>new Promise((resolve,reject)=>{
  host.device(device);
  const timer=setTimeout(()=>{stop();done();resolve(snapshot());},8000);
  const stop=host.onCancel(()=>{clearTimeout(timer);stop();reject(new Error('cancelled'));});
 });
 await stubHost(page,{workspaces:initial.recent,control:(body,host)=>{
  const action=body?.action;
  if(action==='profile')s.profile=String(body.profile);
  if(action==='shisa-logout'){s.signedIn=false;s.modelReady=false;}
  if(action==='custom-provider')s.modelReady=true;
  if(action==='shisa-login')return deviceSignIn(host,{url:'https://platform.shisa.ai/connect',code:'DEMO-1234'},()=>{s.signedIn=true;});
  if(action==='provider-oauth')return deviceSignIn(host,{provider:'openai-codex',url:'https://auth.openai.com/codex/device',code:'DEMO-CODE'},()=>{});
  return snapshot();
 }});
 await page.goto(UI_BASE);
}

test('a missing model with languages already saved opens the connect-a-model page directly', async ({page}) => {
 await openSetup(page,{modelReady:false});
 await expect(page.getByRole('heading',{name:'Connect a model'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Sign in to Shisa.AI',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'English',exact:true})).toHaveCount(0);
});

test('Shisa.AI authorization keeps its actions together and cancels cleanly', async ({page}) => {
 await openSetup(page,{modelReady:false});
 await page.getByRole('button',{name:'Sign in to Shisa.AI',exact:true}).click();
 const open=page.getByRole('button',{name:'Open in browser',exact:true});
 const cancel=page.getByRole('button',{name:'Cancel',exact:true});
 await expect(open).toBeVisible();
 const a=await open.boundingBox(), b=await cancel.boundingBox();
 expect(a?.y).toBe(b?.y);
 expect(b!.x+b!.width).toBeLessThan(a!.x);
 await cancel.click();
 await expect(open).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Sign in to Shisa.AI',exact:true})).toBeVisible();
});

test('Codex OAuth is an Add Provider entry and cancels cleanly', async ({page}) => {
 await openSetup(page,{modelReady:false});
 await page.getByRole('combobox',{name:'Service',exact:true}).click();
 await page.getByRole('option',{name:'Codex',exact:true}).click();
 await expect(page.getByText('OpenAI (ChatGPT Plus/Pro)',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).click();
 await expect(page.getByLabel('Sign-in URL',{exact:true})).toHaveValue('https://auth.openai.com/codex/device');
 await expect(page.getByLabel('Device code',{exact:true})).toHaveValue('DEMO-CODE');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign in with ChatGPT',exact:true})).toBeVisible();
});

test('a configured model opens the workspace', async ({page}) => {
 await openSetup(page,{modelReady:true,recent:[{id:'w1',path:'C:/Projects/Jouzu',environment:{kind:'windows'}}]});
 await expect(page.getByRole('button',{name:'New session',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Connect a model'})).toHaveCount(0);
});
