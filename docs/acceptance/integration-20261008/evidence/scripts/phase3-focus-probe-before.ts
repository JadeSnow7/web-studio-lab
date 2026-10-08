import { writeFile } from 'node:fs/promises';
import { launchApp, workspaceSnapshot } from '../../../../../e2e/helpers';
const events: unknown[] = [];
const { app, page } = await launchApp();
try {
  await app.evaluate(({ app, BrowserWindow, webContents }) => {
    const state = globalThis as any;
    state.__focusProbe = [];
    const record = (kind: string, data: unknown = {}) => state.__focusProbe.push({ time: Date.now(), kind, data, windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, focused: w.isFocused() })), contents: webContents.getAllWebContents().map(w => ({ id: w.id, url: w.getURL(), focused: w.isFocused() })), focused: webContents.getFocusedWebContents()?.id ?? null });
    const attach = (wc: Electron.WebContents) => {
      wc.on('focus', () => record('native-focus', { id: wc.id }));
      wc.on('blur', () => record('native-blur', { id: wc.id }));
      const send = wc.send.bind(wc);
      wc.send = (channel: string, ...args: unknown[]) => {
        if (channel === 'chat:status' || channel === 'workbench:event') record(channel, args);
        send(channel, ...args);
      };
    };
    webContents.getAllWebContents().forEach(attach);
    app.on('web-contents-created', (_event, wc) => attach(wc));
    BrowserWindow.getAllWindows().forEach(w => { w.on('focus', () => record('window-focus')); w.on('blur', () => record('window-blur')); });
    record('installed');
  });
  await page.evaluate(() => {
    const state = window as any;
    state.__focusProbe = [];
    const record = (kind: string, data: unknown = {}) => state.__focusProbe.push({ time: Date.now(), kind, data, active: document.activeElement?.outerHTML, dialogs: [...document.querySelectorAll('dialog')].map(d => ({ open: d.open, text: d.getAttribute('aria-label') })), occlusion: document.body.className });
    window.addEventListener('focus', () => record('renderer-window-focus'));
    window.addEventListener('blur', () => record('renderer-window-blur'));
    document.addEventListener('focusin', () => record('renderer-focusin'));
    document.addEventListener('focusout', () => record('renderer-focusout'));
    window.studio.workbench.onEvent(event => record('snapshot', event));
  });
  const checkpoint = async (kind: string) => events.push({ time: Date.now(), kind, snapshot: await workspaceSnapshot(page), renderer: await page.evaluate(() => ({ active: document.activeElement?.outerHTML, dialogs: [...document.querySelectorAll('dialog')].map(d => ({ open: d.open })), body: document.body.className })), native: await app.evaluate(({ BrowserWindow, webContents }) => ({ windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, focused: w.isFocused() })), contents: webContents.getAllWebContents().map(w => ({ id: w.id, focused: w.isFocused(), url: w.getURL() })), focused: webContents.getFocusedWebContents()?.id ?? null })) });
  await checkpoint('start');
  await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建标签' });
  await dialog.getByLabel('名称').fill('第二网页742');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await checkpoint('save-clicked');
  await dialog.waitFor({state:'hidden'});
  const second = (await workspaceSnapshot(page)).workspaces[0]!.resources.find(r => r.title === '第二网页742')!;
  await page.locator(`#address-${second.resourceId}`).fill('wsl-demo://taskflow/members.html');
  await page.locator(`#address-${second.resourceId}`).press('Enter');
  const web = (await workspaceSnapshot(page)).workspaces[0]!.resources.find(r => r.title === 'TaskFlow 预览')!;
  await checkpoint('before-native-focus');
  await app.evaluate(({ webContents, BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0]!.focus();
    const wc = webContents.fromId(id)!;
    wc.focus();
    wc.sendInputEvent({ type:'mouseDown', x:80,y:80,button:'left',clickCount:1 });
    wc.sendInputEvent({ type:'mouseUp', x:80,y:80,button:'left',clickCount:1 });
  },web.preview!.page.webContentsId);
  for(let i=0;i<15;i++){await checkpoint(`after-focus-${i}`);await new Promise(resolve=>setTimeout(resolve,100));}
  events.push({kind:'native-events', events:await app.evaluate(()=>(globalThis as any).__focusProbe)});
  events.push({kind:'renderer-events', events:await page.evaluate(()=>(window as any).__focusProbe)});
} finally {
  await writeFile(new URL('../phase3-focus-probe.json', import.meta.url),JSON.stringify(events,null,2)+'\n');
  await app.close();
}
