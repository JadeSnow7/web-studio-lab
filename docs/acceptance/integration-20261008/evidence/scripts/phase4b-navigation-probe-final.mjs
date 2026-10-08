import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { _electron } from '@playwright/test';
const desktop = path.resolve('apps/desktop');
const owned = await mkdtemp(path.join(tmpdir(), 'wsl-f27-'));
const profile = path.join(owned, 'profile');
const bootstrap = path.join(owned, 'main.cjs');
await writeFile(bootstrap, `
const { app, ipcMain, webContents } = require('electron');
globalThis.__probeWebContents = webContents;
app.setAppPath(${JSON.stringify(desktop)});
globalThis.__navigationProbe = [];
let loadId = 0;
const record = (kind, data) => globalThis.__navigationProbe.push({ time: Date.now(), kind, ...data });
app.on('web-contents-created', (_event, wc) => {
 const load = wc.loadURL.bind(wc);
 wc.loadURL = (url, ...args) => {
  const id = ++loadId;
  record('load-start', { id, wcId: wc.id, url, stack: new Error().stack });
  return load(url, ...args).then(value => { record('load-resolve', { id, wcId: wc.id, url, actual: wc.getURL() }); return value; }, error => {
   record('load-reject', { id, wcId: wc.id, url, actual: wc.isDestroyed() ? null : wc.getURL(), error: { message:error.message, code:error.code, errno:error.errno, url:error.url } }); throw error;
  });
 };
 wc.on('did-stop-loading',()=>record('load-stopped-event',{wcId:wc.id}));
 wc.on('did-start-navigation', (_event,url,_inPlace,main)=>record('navigation-event',{ wcId:wc.id,url,main }));
 wc.on('did-fail-load', (_event,code,description,url,main)=>record('load-failed-event',{ wcId:wc.id,code,description,url,main }));
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
 const command = args[0];
 if(channel === 'workbench:command')record('command-start',{ commandId:command.commandId, type:command.type, resourceId:command.resourceId, action:command.action, url:command.url });
 const result = await listener(event,...args);
 if(channel === 'workbench:command')record('command-result',{commandId:command.commandId,ok:result.ok,error:result.error});
 return result;
});
require(${JSON.stringify(path.join(desktop,'out/main/index.js'))});
`);
const app = await _electron.launch({ executablePath: createRequire(path.join(desktop,'package.json'))('electron'), args:[bootstrap,`--user-data-dir=${profile}`], cwd:desktop, env:{...process.env,WSL_SBX_BIN:'/missing/wsl-f27-sbx',WSL_SBX_NAME:'fixture-sandbox',WSL_CODEX_BIN:'/missing/host-codex-must-not-run'} });
let capture = {};
try {
 const isWorkbench = p => p.url().startsWith('file:') && p.url().endsWith('/renderer/index.html');
 const page = app.windows().find(isWorkbench) ?? await app.waitForEvent('window',{predicate:isWorkbench});
 await page.evaluate(() => { window.__probeSubmits=[];document.addEventListener('submit',event=>{if(event.target.matches('form.address'))window.__probeSubmits.push({time:Date.now(),value:event.target.querySelector('input').value});},true); });
 await page.getByRole('button',{name:'左右分屏',exact:true}).click();
 await page.getByRole('button',{name:'新建标签',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'新建标签'});
 await dialog.getByLabel('名称').fill('第二网页F27');
 await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 const snapshot = await page.evaluate(()=>window.studio.workbench.getSnapshot());
 const second=snapshot.workspaces[0].resources.find(r=>r.title==='第二网页F27');
 const address=page.locator(`#address-${second.resourceId}`);
 await address.fill('wsl-demo://taskflow/members.html');
 capture.beforeEnter={time:Date.now(),address:await address.inputValue()};
 await address.press('Enter');
 await page.waitForFunction(id=>window.studio.workbench.getSnapshot().then(s=>s.workspaces[0].resources.find(r=>r.resourceId===id)?.preview?.page.url==='wsl-demo://taskflow/members.html'),second.resourceId);
 await new Promise(resolve=>setTimeout(resolve,100));
 capture.contents=await app.evaluate(async()=>Promise.all(globalThis.__probeWebContents.getAllWebContents().filter(wc=>wc.getURL().startsWith('wsl-demo:')).map(async wc=>({wcId:wc.id,url:wc.getURL(),body:await wc.executeJavaScript('document.body.innerText')}))));
 capture={...capture,profile,pid:app.process().pid,events:await app.evaluate(()=>globalThis.__navigationProbe),submits:await page.evaluate(()=>window.__probeSubmits),snapshot:await page.evaluate(()=>window.studio.workbench.getSnapshot()),globalError:await page.locator('.workspace-error').allTextContents()};
} finally {
 await writeFile(process.argv[2] ?? 'docs/acceptance/integration-20261008/evidence/phase4b-navigation-probe.json',JSON.stringify(capture,null,2)+'\n');
 await app.close();
}
