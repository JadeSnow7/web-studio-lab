import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fullBrowserServer } from './fixtures/full-browser-server';
import {
  launchApp,
  workspaceSnapshot,
  openNativeMenuWhen,
  chooseNativeMenuItem,
  resourceCollection,
  screensDir,
  setWindowSize,
} from './helpers';

/** Native views are separate from the host renderer and require their own capture. */
async function browserShots(app: ElectronApplication, page: Page, name: string): Promise<void> {
  await mkdir(screensDir, { recursive: true });
  await page.screenshot({ path: path.join(screensDir, `${name}.png`) });
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()
      .flatMap((window) => window.contentView.children)
      .find((candidate) => (candidate as Electron.WebContentsView).webContents && candidate.getVisible()) as Electron.WebContentsView;
    if (!view) throw new Error('No visible browser view to capture');
    const capture = await view.webContents.capturePage();
    if (capture.isEmpty()) throw new Error('Visible browser capture is empty');
    return capture.toPNG().toString('base64');
  });
  await writeFile(path.join(screensDir, `${name}.preview.png`), Buffer.from(png, 'base64'));
}

async function read(app: ElectronApplication, expression: string) {
  return app.evaluate(async ({ BrowserWindow }, code) => {
    const view = BrowserWindow.getAllWindows()
      .flatMap((w) => w.contentView.children)
      .find((v) => (v as Electron.WebContentsView).webContents && v.getVisible()) as Electron.WebContentsView;
    if (!view) throw new Error('No visible browser view');
    return view.webContents.executeJavaScript(code);
  }, expression);
}
async function navigate(app: ElectronApplication, page: Page, url: string) {
  const address = page.locator('input[id^="address-"]:visible');
  await address.fill(url);
  await address.press('Enter');
  await expect.poll(async () => (await previewInfo(app)).url, { timeout: 30000 }).toBe(url);
  await expect.poll(async () => (await activeBrowserState(app, page))?.loading, { timeout: 30000 }).toBe(false);
  // Successful address submissions explicitly blur after their original command settles.
  await expect(address).toHaveValue(url);
  await expect(address).not.toBeFocused();
}
async function previewInfo(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()
      .flatMap((w) => w.contentView.children)
      .find((v) => (v as Electron.WebContentsView).webContents && v.getVisible()) as Electron.WebContentsView;
    return view ? { url: view.webContents.getURL(), id: view.webContents.id } : { url: '', id: 0 };
  });
}
async function activeBrowserState(app: ElectronApplication, page: Page) {
  const { id } = await previewInfo(app);
  const state = await workspaceSnapshot(page);
  return state.workspaces.flatMap((workspace) => workspace.resources).find((resource) => resource.preview?.page.webContentsId === id)
    ?.preview;
}
async function previewElementCenter(app: ElectronApplication, selector: string) {
  return read(
    app,
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  );
}
async function click(app: ElectronApplication, selector: string) {
  const point = await previewElementCenter(app, selector);
  const { id } = await previewInfo(app);
  await app.evaluate(
    ({ webContents }, { id, point }) => {
      const wc = webContents.fromId(id)!;
      wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    },
    { id, point },
  );
}

test('real Chromium HTTP fixture: rendering, forms, login, popups, snapshots, isolation and restart', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180000);
  const server = await fullBrowserServer();
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-full-browser-'));
  let { app, page } = await launchApp({ userData });
  try {
    await expect.poll(async () => (await activeBrowserState(app, page))?.loading, { timeout: 30000 }).toBe(false);
    await app.evaluate(({ shell }) => {
      (globalThis as typeof globalThis & { externalOpens: string[] }).externalOpens = [];
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { externalOpens: string[] }).externalOpens.push(url);
      };
    });
    await navigate(app, page, server.url + '/#initial');
    await expect.poll(() => read(app, "document.querySelector('#worker').textContent")).toBe('fetch works');
    await expect.poll(() => read(app, "document.querySelector('#service-worker').textContent")).toBe('fetch works');
    expect(await read(app, "document.querySelector('#srcdoc').contentDocument.body.innerText")).toBe('srcdoc works');
    await expect.poll(() => read(app, "document.querySelector('#websocket').textContent")).toBe('websocket works');
    const rendered = await read(
      app,
      `({css:getComputedStyle(document.querySelector('#styled')).color,image:document.querySelector('#image').naturalWidth,script:window.fixtureExecuted,frame:document.querySelector('#frame').contentDocument.querySelector('#frame-body').textContent,frameStudio:document.querySelector('#frame').contentWindow.frameStudio,fetch:document.querySelector('#fetch').textContent,studio:typeof window.studio,require:typeof window.require,process:typeof window.process})`,
    );
    expect(rendered).toEqual({
      css: 'rgb(18, 52, 86)',
      image: 8,
      script: true,
      frame: 'frame works',
      frameStudio: 'undefined',
      fetch: 'fetch works',
      studio: 'undefined',
      require: 'undefined',
      process: 'undefined',
    });
    await read(app, "document.querySelector('#query').value='fixture search'");
    await click(app, '#search');
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/search?q=fixture+search');
    expect(await read(app, "document.querySelector('#route').textContent")).toBe('Search: fixture search');
    await click(app, '#login');
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/account');
    await expect.poll(() => read(app, "document.querySelector('#fetch').textContent")).toBe('fetch works authenticated');
    expect(server.requests.find((r) => r.path === '/login')?.body).toContain('password=DO-NOT-CAPTURE-PASSWORD');
    expect(await read(app, "document.querySelector('#storage').textContent")).toBe('persistent-login');
    for (const selector of ['#popup', '#blank-popup']) {
      await click(app, selector);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.contentView.children.length === 0)
              ?.getTitle(),
          ),
        )
        .toBe(server.url + '/popup');
      const popup = await app.evaluate(async ({ BrowserWindow }) => {
        const popup = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length === 0)!;
        const prefs = (
          popup.webContents as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences }
        ).getLastWebPreferences();
        return {
          url: popup.webContents.getURL(),
          sandbox: prefs.sandbox,
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          webSecurity: prefs.webSecurity,
          webviewTag: prefs.webviewTag,
          workerNode: prefs.nodeIntegrationInWorker,
          insecure: prefs.allowRunningInsecureContent,
          preload: prefs.preload,
          opener: await popup.webContents.executeJavaScript('!!window.opener'),
        };
      });
      expect(popup).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        workerNode: false,
        insecure: false,
        opener: true,
      });
      expect(popup.preload).toBeFalsy();
      await app.evaluate(async ({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length === 0)!.webContents;
        const point = await wc.executeJavaScript(
          "(()=>{const r=document.querySelector('#complete').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
        );
        wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      });
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      await expect.poll(() => read(app, "document.querySelector('#message').textContent")).toBe('popup-login-complete');
      expect(await read(app, "localStorage.getItem('popup')")).toBe('shared');
    }
    await click(app, '#spa');
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/account#spa');
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/account');
    await page.getByRole('button', { name: '前进', exact: true }).click();
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/account#spa');
    await page.getByRole('button', { name: '刷新页面', exact: true }).click();
    await expect.poll(() => read(app, "document.querySelector('#fetch').textContent")).toBe('fetch works authenticated');
    for (const selector of ['#external', '#file']) {
      await click(app, selector);
      expect((await previewInfo(app)).url).toBe(server.url + '/account#spa');
    }
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { externalOpens: string[] }).externalOpens)).toEqual([]);
    const more = () => page.getByRole('button', { name: '更多网页操作', exact: true }).click();
    await openNativeMenuWhen(app, more, '保存正文快照', true);
    await chooseNativeMenuItem(app, '保存正文快照');
    await expect.poll(async () => (await resourceCollection(page)).resources.length).toBe(1);
    const snapshot = (await resourceCollection(page)).resources[0]!;
    expect(snapshot.text).toContain('Full browser fixture');
    expect(snapshot.text).not.toMatch(/DO-NOT-CAPTURE|fixture-user/);
    const before = await workspaceSnapshot(page);
    const workspaceId = before.activeWorkspaceId;
    const second = await page.evaluate(
      async ({ workspaceId, url }) =>
        window.studio.workbench.command({
          commandId: crypto.randomUUID(),
          workspaceId,
          type: 'createTab',
          kind: 'web',
          title: 'Shared login',
          url,
        }),
      { workspaceId, url: server.url + '/shared' },
    );
    expect(second.ok).toBe(true);
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/shared');
    await expect.poll(() => read(app, "document.querySelector('#fetch')?.textContent")).toBe('fetch works authenticated');
    // Main profile does not inherit site cookies/local storage from the browser partition.
    const defaultCookie = await app.evaluate(
      async ({ session }, url) => (await session.defaultSession.cookies.get({ url })).length,
      server.url,
    );
    expect(defaultCookie).toBe(0);
    const other = crypto.randomUUID();
    const created = await page.evaluate(
      async (workspaceId) =>
        window.studio.workbench.command({ commandId: crypto.randomUUID(), workspaceId, type: 'createWorkspace', name: 'Isolated browser' }),
      other,
    );
    expect(created.ok).toBe(true);
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page.getByRole('dialog', { name: '切换空间', exact: true }).getByText('Isolated browser', { exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).activeWorkspaceId).toBe(other);
    const isolated = await page.evaluate(
      async ({ workspaceId, url }) =>
        window.studio.workbench.command({
          commandId: crypto.randomUUID(),
          workspaceId,
          type: 'createTab',
          kind: 'web',
          title: 'Isolated site',
          url,
        }),
      { workspaceId: other, url: server.url + '/isolated' },
    );
    expect(isolated.ok).toBe(true);
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/isolated');
    await expect.poll(() => read(app, "document.querySelector('#fetch').textContent")).toBe('fetch works');
    expect(await read(app, "localStorage.getItem('login')")).toBeNull();
    await page.getByRole('button', { name: '切换空间', exact: true }).click();
    await page.getByRole('dialog', { name: '切换空间', exact: true }).getByText('TaskFlow', { exact: true }).click();
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/shared');
    await expect.poll(() => read(app, "localStorage.getItem('login')")).toBe('persistent-login');
    await browserShots(app, page, 'full-browser-fixture');
    await app.close();
    ({ app, page } = await launchApp({ userData }));
    await expect.poll(async () => (await activeBrowserState(app, page))?.loading, { timeout: 30000 }).toBe(false);
    // Use the visible address bar again after a full process restart.
    await navigate(app, page, server.url + '/restarted');
    await expect.poll(() => read(app, "document.querySelector('#fetch').textContent")).toBe('fetch works authenticated');
    expect(await read(app, "localStorage.getItem('login')")).toBe('persistent-login');
    const restored = (await resourceCollection(page)).resources.find((value) => value.url === snapshot.url)!;
    expect(restored.text).toBe(snapshot.text);
    expect(restored.contentSha256).toBe(snapshot.contentSha256);
    expect(restored).toMatchObject({ extractionVersion: 'host-rendered-dom-text-v1', sourceKind: 'rendered-visible-text' });
    await setWindowSize(app, 900, 700);
    await navigate(app, page, server.url + '/narrow');
    await expect(page.locator('input[id^="address-"]:visible')).toBeVisible();
    await setWindowSize(app, 1440, 900);
    await expect.poll(async () => (await previewInfo(app)).url).toBe(server.url + '/narrow');
    const activeId = (await previewInfo(app)).id;
    const address = page.locator('input[id^="address-"]:visible');
    const requestCount = server.requests.length;
    await address.fill(server.url + '/disconnect');
    await expect(address).toHaveValue(server.url + '/disconnect');
    await expect(address).toBeFocused();
    await address.press('Enter');
    try {
      await expect.poll(() => server.requests.slice(requestCount).some((request) => request.path === '/disconnect')).toBe(true);
      await expect.poll(async () => (await activeBrowserState(app, page))?.loadError?.description).toBeTruthy();
    } catch (error) {
      await mkdir(testInfo.outputDir, { recursive: true });
      const file = testInfo.outputPath('disconnect-diagnostic.json');
      await writeFile(
        file,
        JSON.stringify(
          {
            activeId,
            requests: server.requests.slice(requestCount),
            native: await previewInfo(app),
            preview: await activeBrowserState(app, page),
            address: await address.inputValue(),
            focused: await address.evaluate((element) => element === document.activeElement),
          },
          null,
          2,
        ),
      );
      await testInfo.attach('disconnect-diagnostic', { path: file, contentType: 'application/json' });
      throw error;
    }
    await navigate(app, page, server.url + '/recovered');
    await expect.poll(() => read(app, "document.querySelector('#fetch').textContent")).toBe('fetch works authenticated');
    await browserShots(app, page, 'full-browser-fixture-recovered');
    await click(app, '#target');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.contentView.children.length === 0)
            ?.webContents.getURL(),
        ),
      )
      .toBe(server.url + '/next');
    const cleanup = await page.evaluate(async (id) => {
      const state = await window.studio.workbench.getSnapshot();
      const w = state.workspaces.find((w) => w.workspaceId === state.activeWorkspaceId)!;
      const resource = w.resources.find((r) => r.preview?.page.webContentsId === id)!;
      const tabs = w.tabs.filter((t) => t.targetRef.resourceId === resource.resourceId);
      for (const tab of tabs) {
        const closed = await window.studio.workbench.command({
          commandId: crypto.randomUUID(),
          workspaceId: w.workspaceId,
          type: 'closeTab',
          tabId: tab.tabId,
        });
        if (!closed.ok) return closed;
      }
      return window.studio.workbench.command({
        commandId: crypto.randomUUID(),
        workspaceId: w.workspaceId,
        type: 'stopInstance',
        resourceId: resource.resourceId,
        instanceId: resource.instanceId!,
      });
    }, activeId);
    expect(cleanup.ok).toBe(true);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await testInfo.attach('controlled-http-evidence', {
      body: JSON.stringify(
        { kind: 'controlled-local-http-real-electron', realAccountLoginVerified: false, rendered, requests: server.requests, snapshot },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    await app.close();
    await server.close();
  }
});

test('opt-in public network: Example and Baidu native page search', async ({ browserName: _browserName }, testInfo) => {
  test.skip(process.env['WSL_BROWSER_PUBLIC_NETWORK'] !== '1', 'Explicit opt-in for real public websites; no model or sandbox live.');
  test.setTimeout(150000);
  const { app, page } = await launchApp();
  let completed = false;
  const saveJsonEvidence = async (name: string, value: unknown) => {
    await mkdir(testInfo.outputDir, { recursive: true });
    const file = testInfo.outputPath(`${name}.json`);
    await writeFile(file, JSON.stringify(value, null, 2));
    await testInfo.attach(name, { path: file, contentType: 'application/json' });
  };
  const visibleControl = (selectors: string[]): Promise<string> =>
    read(
      app,
      `(() => {
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') return selector;
    }
    throw new Error('No visible website control: ' + selectors.join(', '));
  })()`,
    );
  const diagnostics = () =>
    read(
      app,
      `(() => {
    const describe = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {tag:element.tagName,id:element.id,name:element.getAttribute('name'),type:element.getAttribute('type'),role:element.getAttribute('role'),
        value:element.id==='kw' ? element.value : undefined,text:element.innerText?.slice(0,300),disabled:element.disabled,contentEditable:element.contentEditable,
        display:style.display,visibility:style.visibility,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
    };
    return {url:location.href,title:document.title,readyState:document.readyState,kw:describe(document.querySelector('#kw')),activeElement:describe(document.activeElement),
      inputs:Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]')).slice(0,40).map(describe),
      forms:Array.from(document.forms).slice(0,20).map(form=>({id:form.id,action:form.action,method:form.method,elements:Array.from(form.elements).slice(0,30).map(describe)})),
      buttons:Array.from(document.querySelectorAll('button,input[type=submit],[role=button]')).slice(0,40).map(describe),text:document.body.innerText.slice(0,12000)};
  })()`,
    );
  try {
    await expect.poll(async () => (await activeBrowserState(app, page))?.loading, { timeout: 30000 }).toBe(false);
    await navigate(app, page, 'https://example.com/');
    await expect.poll(() => read(app, 'document.body.innerText')).toContain('This domain is for use in documentation examples');
    await browserShots(app, page, 'full-browser-public-example');
    await navigate(app, page, 'https://www.baidu.com/');
    const inputSelector = await visibleControl(['#chat-textarea', '#kw']);
    await click(app, inputSelector);
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()
        .flatMap((window) => window.contentView.children)
        .find((candidate) => (candidate as Electron.WebContentsView).webContents && candidate.getVisible()) as Electron.WebContentsView;
      if (!view) throw new Error('No visible browser view');
      view.webContents.insertText('Electron 浏览器');
    });
    await expect.poll(() => read(app, `document.querySelector(${JSON.stringify(inputSelector)}).value`)).toContain('Electron 浏览器');
    const submitSelector = await visibleControl(['#chat-submit-button', '#su']);
    await browserShots(app, page, 'full-browser-public-baidu-before-submit');
    await saveJsonEvidence('baidu-before-submit-dom', { controls: { inputSelector, submitSelector }, document: await diagnostics() });
    await click(app, submitSelector);
    await expect.poll(async () => (await previewInfo(app)).url, { timeout: 30000 }).toContain('/s?');
    await expect.poll(() => read(app, 'document.body.innerText'), { timeout: 30000 }).toMatch(/Electron/iu);
    const evidence = await read(
      app,
      '({url:location.href,title:document.title,text:document.body.innerText.slice(0,12000),results:document.querySelectorAll("#content_left .result,#content_left .c-container").length})',
    );
    await browserShots(app, page, 'full-browser-public-baidu-search');
    await saveJsonEvidence('public-network-evidence', evidence);
    expect(evidence.results).toBeGreaterThan(0);
    completed = true;
  } finally {
    try {
      if (!completed) {
        const results = await Promise.allSettled([
          browserShots(app, page, 'full-browser-public-baidu-failure'),
          diagnostics().then((value) => saveJsonEvidence('baidu-failure-dom', value)),
        ]);
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected')
            await testInfo.attach(`baidu-failure-diagnostic-error-${index}`, { body: String(result.reason), contentType: 'text/plain' });
        }
      }
    } finally {
      await app.close();
    }
  }
});
