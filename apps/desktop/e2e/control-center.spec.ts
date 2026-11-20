import { test, expect } from '@playwright/test';
import { expect as expectBase, type Locator } from '@playwright/test';
import { UI_BASE, stubHostControl } from './host-control';

// An error reads as one sentence that says what failed; the raw text is behind Details.
async function expectError(alert: Locator, sentence: string, raw: string) {
  await expectBase(alert).toContainText(sentence);
  await alert.getByRole('button', { name: 'Details', exact: true }).click();
  await expectBase(alert).toContainText(raw);
}
const state = {schemaVersion:1,profile:'core',account:{signedIn:false},credentials:[],customProviders:[],providers:[{id:'openai',name:'OpenAI'}],models:[]};
// The System rows for Git Bash and the terminal exist only on Windows, which the window reads from the user agent.
test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
const control = (legacy: boolean) => (body: any) => {
  const result: any = { ...state };
  if (body?.action === 'profile') result.profile = body.profile;
  if (legacy) delete result.customProviders;
  return result;
};
test.beforeEach(async ({page}, testInfo) => {
  await stubHostControl(page, control(testInfo.title.includes('rejects old protocol')));
});
for (const legacy of [false,true]) {
 test(`control center ${legacy ? 'rejects old protocol without crashing' : 'opens all tabs'}`, async ({page}) => {
  const errors: string[]=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript(({state,legacy}) => {
   (window as any).isTauri = true;
   (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
   localStorage.setItem('jouzu.ui.language','en');
   (window as any).__TAURI_INTERNALS__ = {
    metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
    transformCallback:()=>1, unregisterCallback:()=>{},
    invoke:async (command:string, args?:any) => {
     if(command==='shell_state') return {ready:true,bash:true,recent:[],platform:'windows'};
     if(command==='component_versions') return {jouzu:'0.1.18',development:true};
     if(command==='control_request') {if(args?.request?.action==='profile')state.profile=args.request.profile;const result={...state};if(legacy)delete (result as any).customProviders;return result;}
     if(command==='environment_read') return [];
     if(command.includes('version'))return '0.1.0';
     return 1;
    }
   };
  },{state,legacy});
  await page.goto(UI_BASE);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  if(legacy) await expectError(dialog.getByRole('alert'), 'Something went wrong', 'incompatible');
  else { await dialog.getByRole('button',{name:'Add provider',exact:true}).click(); await expect(dialog.getByRole('combobox',{name:'Service',exact:true})).toBeVisible(); await expect(dialog.getByRole('button',{name:'Add provider',exact:true})).toHaveCount(0); await expect(dialog.getByRole('combobox')).toHaveCount(1); await dialog.getByRole('combobox',{name:'Service',exact:true}).click(); await page.getByRole('option',{name:'Custom provider',exact:true}).click(); await expect(dialog.getByRole('textbox',{name:'API base URL'})).toBeVisible(); }
  await dialog.getByRole('tab',{name:'Environment',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Add variable',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Add variable',exact:true}).click();
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('TEST_TOKEN');
  await dialog.getByLabel('Value',{exact:true}).fill('fixture-secret');
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  await expect(dialog.getByLabel('Value',{exact:true})).toHaveCount(0);
  await expect(dialog.getByText('TEST_TOKEN',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Edit',exact:true}).click();
  await expect(dialog.getByLabel('Value',{exact:true})).toHaveValue('fixture-secret');
  await dialog.getByRole('tab',{name:'Language',exact:true}).click();
  await expect(dialog.getByRole('combobox',{name:'Interface language'})).toBeVisible();
  await expect(dialog.getByRole('combobox')).toHaveCount(3);
  const toggle=dialog.getByRole('switch',{name:'Japanese-first mode',exact:true});
  if(!legacy) {
   await expect(toggle).not.toBeChecked();
   await toggle.click(); await expect(toggle).toBeChecked();
   await toggle.click(); await expect(toggle).not.toBeChecked();
  } else await expect(toggle).toBeDisabled();
  await expect(dialog.getByText(/Changing the interface language does not turn this off/)).toBeVisible();
  expect(errors).toEqual([]);
 });
}

const updateStub = (config: {
  version: string; target?: string; available: boolean; downgrade?: boolean; notes?: string;
  configured?: boolean; checkFails?: boolean; installFails?: boolean;
  runtime?: string | null; commit?: string; build?: string;
}) => {
  const callbacks: Record<number, Function> = {};
  const listeners: Record<string, number[]> = {};
  let next = 1;
  (window as any).isTauri = true;
  (window as any).__installs = 0;
  (window as any).__logs = [];
  (window as any).__emit = (event: string, payload: any) => (listeners[event] ?? []).forEach(id => callbacks[id]({event, id, payload}));
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    unregisterCallback: () => {},
    transformCallback: (fn: Function) => { callbacks[next] = fn; return next++; },
    invoke: async (command: string, args: any) => {
      if (command === 'plugin:event|listen') { (listeners[args.event] ??= []).push(args.handler); return next++; }
      if (command === 'plugin:event|unlisten' || command === 'plugin:event|emit') return null;
      if (command === 'shell_state') return { ready: true, bash: true, recent: [], platform: 'windows' };
      if (command === 'component_versions') return {
        jouzu: config.runtime === undefined ? '0.2.5' : config.runtime,
        development: false,
        desktopUpdaterConfigured: config.configured !== false,
        build: config.build,
        commit: config.commit,
      };
      if (command === 'runtime_report') return { version: config.runtime ?? null, nodeCurrent: true };
      if (command === 'control_request') return { schemaVersion: 1, profile: 'core', account: { signedIn: false }, credentials: [], customProviders: [], providers: [] };
      if (command === 'environment_read') return [];
      if (command === 'git_bash' || command === 'terminal' || command === 'command_entry_report') return 1;
      if (command === 'plugin:dialog|confirm' || command === 'plugin:dialog|message') return true;
      if (command === 'log_event') { (window as any).__logs.push(args.message); return null; }
      // The app's own update commands (src-tauri update_channel.rs), which pick the feed by channel.
      if (command === 'update_channel' || command === 'update_channel_set') return args?.channel ?? 'stable';
      if (command === 'update_check') {
        if (config.checkFails) throw new Error('network');
        return config.available
          ? { version: config.target, notes: config.notes ?? null, channel: 'stable', downgrade: !!config.downgrade }
          : null;
      }
      if (command === 'update_install') {
        (window as any).__installs++;
        if (config.installFails && (window as any).__installs === 1) throw new Error('Download failed. Your current version is unchanged.');
        return new Promise(() => {});
      }
      if (command.includes('version')) return config.version;
      return 1;
    },
  };
};

async function openSystem(page: any) {
  await page.goto(UI_BASE);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'System', exact: true }).click();
  return dialog;
}

test('the System section shows one Jouzu Desktop row, with the runtime as a detail', async ({ page }) => {
  await page.addInitScript(updateStub, {
    version: '1.1.4-rc.1', available: false, commit: '81d7bae9a5b9', build: '20261119T095741798Z-292c4003',
  });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expect(row).toHaveCount(1);
  await expect(dialog.locator('section[aria-label="Jouzu"]')).toHaveCount(0);
  await expect(row.getByText('1.1.4-rc.1')).toBeVisible();
  await expect(row.getByText('Runtime 0.2.5')).toBeVisible();
  await expect(row.getByText('Up to date')).toBeVisible();
  // The commit and build stamp live in a tooltip, not on a line of their own.
  await expect(row.getByText('81d7bae9a5b9')).toHaveCount(0);
  await expect(row.getByText('20261119T095741798Z-292c4003')).toHaveCount(0);
  await expect(row.getByTitle(/81d7bae9a5b9/)).toHaveAttribute('title', /20261119T095741798Z-292c4003/);
  await expect(row.getByText('Update available')).toHaveCount(0);
  await expect(row.getByText('Online updates are unavailable')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__logs)).toContain('desktop update check result=current');
});

test('a failed update check is reported and recorded', async ({ page }) => {
  await page.addInitScript(updateStub, { version: '1.1.4-rc.1', available: false, checkFails: true });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expectError(row.getByRole('alert'), 'Could not check for updates', 'network');
  const logs: string[] = await page.evaluate(() => (window as any).__logs);
  expect(logs.some(line => line.startsWith('desktop update check failed error='))).toBe(true);
});

test('a newer build offers Update and restart with its notes, and confirms once', async ({ page }) => {
  await page.addInitScript(updateStub, {
    version: '1.1.4-rc.1', target: '1.1.5', available: true,
    notes: '### Release notes\n- Git Bash is prepared during installation.\n- Startup no longer fails after an update.',
  });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expect(row.getByText('Update available', { exact: true })).toBeVisible();
  // Notes live in a bounded, scrollable area rather than a clipped box.
  const notes = row.locator('div.max-h-40');
  await expect(notes).toHaveClass(/overflow-auto/);
  expect(await notes.evaluate((node: HTMLElement) => node.scrollHeight >= node.clientHeight)).toBe(true);
  await row.getByRole('button', { name: 'Update and restart', exact: true }).click();
  const confirm = page.getByRole('dialog').last();
  await expect(confirm.getByText('Jouzu Desktop restarts after updating.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Update and restart', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__installs)).toBe(1);
});

test('installing reports progress', async ({ page }) => {
  await page.addInitScript(updateStub, { version: '1.1.4-rc.1', target: '1.1.5', available: true });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await row.getByRole('button', { name: 'Update and restart', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Update and restart', exact: true }).click();
  await page.evaluate(() => (window as any).__emit('desktop-update-progress', { downloaded: 5, total: 10 }));
  await expect(row.getByRole('progressbar')).toBeVisible();
});

test('an older build on the channel is a test build, not an update (#176)', async ({ page }) => {
  await page.addInitScript(updateStub, {
    version: '1.1.4-rc.1', target: '1.0.23', available: true, downgrade: true,
    notes: '### Notes this build already has\n- Old change.',
  });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expect(row.getByText('This is a test build')).toBeVisible();
  const install = row.getByRole('button', { name: 'Install Stable 1.0.23 (older)', exact: true });
  await expect(install).toBeVisible();
  await expect(install).toHaveClass(/border/);
  await expect(row.getByText('Update available')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Update and restart', exact: true })).toHaveCount(0);
  await expect(row.getByText("What's new")).toHaveCount(0);
  await expect(row.getByText('Old change.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update available', exact: true })).toHaveCount(0);
  await install.click();
  const confirm = page.getByRole('dialog').last();
  await expect(confirm.getByText('This installs an older version of Jouzu Desktop. Your data stays.')).toBeVisible();
});

test('a failed install offers Retry and the retry needs no second confirmation', async ({ page }) => {
  await page.addInitScript(updateStub, { version: '1.1.4-rc.1', target: '1.1.5', available: true, installFails: true });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await row.getByRole('button', { name: 'Update and restart', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Update and restart', exact: true }).click();
  await expectError(row.getByRole('alert'), 'Could not install the update', 'Your current version is unchanged');
  await row.getByRole('button', { name: 'Retry', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__installs)).toBe(2);
});

test('a missing runtime is a detail line with Repair as the row\'s one action', async ({ page }) => {
  await page.addInitScript(updateStub, { version: '1.1.4-rc.1', target: '1.1.5', available: true, runtime: null });
  const dialog = await openSystem(page);
  const row = dialog.locator('section[aria-label="Jouzu Desktop"]');
  await expect(row.getByText('The runtime is missing.')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Repair Jouzu', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Update and restart', exact: true })).toHaveCount(0);
  await expect(row.getByText('Update available')).toHaveCount(0);
});

test('the System section names the copy in use and offers installing the ones Jouzu ships', async ({page})=>{
 await page.addInitScript(()=>{
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  localStorage.setItem('jouzu.ui.language','en');
  const environment=(git:string,root:string)=>({path:root+'\bin\bash.exe',git,bash:'GNU bash, version 5.2.37(1)-release'});
  const state:any={bundled:null,managed:null,system:environment('git version 2.51.0.windows.1','C:\Program Files\Git'),preferred:null,archive:true,effective:null};
  const settle=()=>({...state,effective:state.bundled??state.managed??state.system});
  state.effective=settle().effective;
  const terminal:any={bundled:null,system:{path:'C:\Program Files\WindowsApps\wt.exe',version:'1.25.2733.0'},preferred:null,archive:false,version:'1.25.2733.0',effective:null};
  const settleTerminal=()=>({...terminal,effective:terminal.bundled?.path??terminal.system?.path});
  terminal.effective=settleTerminal().effective;
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},
   invoke:async(command:string)=>{(window as any).__invoked=((window as any).__invoked??[]).concat(command);if(command==='plugin:dialog|message')return 'Ok';
    if(command==='shell_state')return {ready:true,bash:false,recent:[],platform:'windows'};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='environment_read')return [];
    if(command==='terminal')return {...terminal};
    if(command==='terminal_install'){terminal.bundled={path:'C:\Program Files\Jouzu\terminal\WindowsTerminal.exe',version:'1.25.2733.0'};return settleTerminal();}
    if(command==='git_bash')return {...state};
    if(command==='git_bash_install'){state.bundled=environment('git version 2.55.0.windows.5','C:\Users\test\AppData\Local\Shisa.ai\Jouzu\runtime\git\installed');return settle();}
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 });
 await page.goto(UI_BASE);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('tab',{name:'System',exact:true}).click();
 // Nothing here switches copies: the row names the one in use and offers installing the shipped one.
 await expect(dialog.getByRole('radio')).toHaveCount(0);
 const bash=dialog.locator('section[aria-label="Git Bash"]');
 await expect(bash.getByRole('button')).toBeEnabled();
 const installBash=bash.getByRole('button',{name:/Install and use Jouzu's Git Bash/});
 await expect(installBash).toBeVisible();
 await installBash.click();
 await expect(bash.getByRole('button',{name:/Install and use Jouzu's Git Bash/})).toHaveCount(0);
 // The console host follows the same rule.
 const terminalRow=dialog.locator('section[aria-label="Windows Terminal"]');
 await expect(terminalRow.getByRole('button')).toBeEnabled();
 const installTerminal=terminalRow.getByRole('button',{name:/Install and use Jouzu's Windows Terminal/});
 await installTerminal.click();
 await expect(terminalRow.getByRole('button',{name:/Install and use Jouzu's Windows Terminal/})).toHaveCount(0);
});
test('a component row keeps its height while an action runs', async ({page})=>{
 await page.addInitScript(()=>{
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  localStorage.setItem('jouzu.ui.language','en');
  const terminal={bundled:null,system:null,preferred:null,effective:null,archive:true,version:'1.25.2733.0',choice:'bundled'};
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},
   invoke:async(command:string)=>{(window as any).__invoked=((window as any).__invoked??[]).concat(command);if(command==='plugin:dialog|message')return 'Ok';
    if(command==='shell_state')return {ready:true,bash:false,recent:[],platform:'windows'};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='environment_read')return [];
    if(command==='terminal')return {...terminal};
    if(command==='terminal_install')return new Promise(()=>{});
    if(command==='git_bash')return 1;
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 });
 await page.goto(UI_BASE);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('tab',{name:'System',exact:true}).click();
 const row=dialog.locator('section[aria-label="Windows Terminal"]');
 const before=(await row.boundingBox())!.height;
 await row.getByRole('button',{name:/Install and use Jouzu's Windows Terminal/}).click();
 await expect(row.locator('svg.animate-spin')).toBeVisible();
 await page.waitForTimeout(600);
 const during=(await row.boundingBox())!.height;
 expect(during).toBe(before);
});

test('a component copy that is here but does not run is repaired, not installed', async ({page})=>{
 await page.addInitScript(()=>{
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  localStorage.setItem('jouzu.ui.language','en');
  // Both components have a directory on disk and nothing in it that answers a launch.
  const git:any={bundled:null,managed:null,system:null,bundled_present:true,managed_present:false,system_present:false,archive:true,effective:null};
  const terminal:any={bundled:null,system:null,bundled_present:true,archive:false,version:'1.25.2733.0',effective:null};
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},
   invoke:async(command:string)=>{(window as any).__invoked=((window as any).__invoked??[]).concat(command);if(command==='plugin:dialog|message')return 'Ok';
    if(command==='shell_state')return {ready:true,bash:false,recent:[],platform:'windows'};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='environment_read')return [];
    if(command==='git_bash')return {...git};
    if(command==='terminal')return {...terminal};
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 });
 await page.goto(UI_BASE);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('tab',{name:'System',exact:true}).click();
 const bash=dialog.locator('section[aria-label="Git Bash"]');
 await expect(bash.getByRole('button')).toHaveCount(1);
 await expect(bash.getByRole('button')).toBeEnabled();
 const terminalRow=dialog.locator('section[aria-label="Windows Terminal"]');
 await expect(terminalRow.getByRole('button')).toHaveCount(1);
 await expect(terminalRow.getByRole('button')).toBeEnabled();
});

test('the terminal command row names what answers and takes precedence only when asked', async ({page})=>{
 await page.addInitScript(()=>{
  (window as any).isTauri=true;
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  localStorage.setItem('jouzu.ui.language','en');
  const shadowed:any={directory:'C:/managed/bin',shims:true,onPath:true,position:'later',first:false,shadowed:true,commands:[{name:'jz',path:'C:/Users/test/AppData/Roaming/npm/jz.cmd'},{name:'jouzu',path:null}]};
  const answered:any={directory:'C:/managed/bin',shims:true,onPath:true,position:'first',first:true,shadowed:false,commands:[{name:'jz',path:'C:/managed/bin/jz.cmd'},{name:'jouzu',path:'C:/managed/bin/jouzu.cmd'}]};
  let entry:any={...shadowed};
  (window as any).__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:()=>1,unregisterCallback:()=>{},
   invoke:async(command:string)=>{(window as any).__invoked=((window as any).__invoked??[]).concat(command);if(command==='plugin:dialog|message')return 'Ok';
    if(command==='shell_state')return {ready:true,bash:false,recent:[],platform:'windows'};
    if(command==='component_versions')return {jouzu:'0.1.18',development:true};
    if(command==='environment_read')return [];
    if(command==='command_entry_report')return {...entry};
    if(command==='command_entry_use'){entry={...answered};return {...entry};}
    if(command==='command_entry_restore'){entry={...shadowed,commands:[{name:'jz',path:'C:/managed/bin/jz.cmd'},{name:'jouzu',path:'C:/Users/test/AppData/Roaming/npm/jouzu.cmd'}]};return {...entry};}
    if(command.includes('version'))return '0.1.0';
    return 1;
   }
  };
 });
 await page.goto(UI_BASE);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByRole('tab',{name:'System',exact:true}).click();
 const row=dialog.locator('section[aria-label="Terminal command"]');
 // The command another installation answers with is named before anything is changed.
 await expect(row.getByRole('button')).toBeVisible();
 await row.getByRole('button').click();
 await expect.poll(async ()=> page.evaluate(()=>(window as any).__invoked)).toContain('command_entry_use');
 // Once a command of Jouzu's answers, the slot is empty: no disabled button, no second action.
 await expect(row.getByRole('button')).toHaveCount(0);
});
