import { test, expect } from '@playwright/test';
const state = {schemaVersion:1,profile:'core',account:{signedIn:false},credentials:[],customProviders:[],providers:[{id:'openai',name:'OpenAI'}],models:[]};

test('settings keeps the view behind it unusable', async ({page}) => {
  await page.addInitScript(({state}) => {
    (window as any).isTauri = true;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    localStorage.setItem('jouzu.ui.language','en');
    (window as any).__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
      transformCallback:()=>1, unregisterCallback:()=>{},
      invoke:async (command:string) => {
        if(command==='shell_state') return {ready:true,bash:true,recent:[],platform:'windows'};
        if(command==='component_versions') return {jouzu:'0.1.18',development:true};
        if(command==='control_request') return {...state};
        if(command==='environment_read') return [];
        if(command.includes('version')) return '0.1.0';
        return 1;
      }
    };
  },{state});
  await page.goto('http://localhost:1420');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // A point outside the dialog belongs to the shield, not to the page underneath.
  const shield = page.locator('[data-settings-shield]');
  await expect(shield).toBeVisible();
  await page.mouse.click(24, 400);
  await expect(dialog).toBeVisible();

  // Escape still closes it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The close control lives in the settings sidebar header and still closes the dialog.
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(dialog).toBeHidden();
});
