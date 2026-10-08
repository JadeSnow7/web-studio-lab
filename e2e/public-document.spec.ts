import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, previewInfo, screensDir, setWindowSize, windowShots, browserState } from './helpers';
import { resourceCollection } from './helpers';

interface NetworkFixture {
  requests: { url: string; family: number | undefined; headers: unknown }[];
}
type FixtureGlobal = typeof globalThis & { publicNetworkFixture: NetworkFixture };
let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  if (app) await app.close();
});

test('controlled-network fixture：真实 Electron 协议跳转、显示、绑定与空间持久化', async () => {
  // 只替换测试进程的 Node 网络边界；协议、Chromium、IPC 与资源存储均用真实实现。
  // 此结果不证明真实公网可达，不调用模型，也不改变生产权限/解析器。
  ({ app, page } = await launchApp());
  await mkdir(screensDir, { recursive: true });
  await setWindowSize(app, 1440, 900);
  await app.evaluate(() => {
    const dns = process.getBuiltinModule('node:dns/promises');
    const https = process.getBuiltinModule('node:https');
    const { EventEmitter } = process.getBuiltinModule('node:events');
    (globalThis as FixtureGlobal).publicNetworkFixture = { requests: [] };
    dns.lookup = (async (hostname: string) => {
      if (!['example.com', 'docs.docker.com'].includes(hostname)) throw new Error('fixture: unexpected DNS target');
      return [{ address: '93.184.216.34', family: 4 }];
    }) as unknown as typeof dns.lookup;
    https.request = ((
      url: URL,
      options: { family?: number; headers?: unknown; rejectUnauthorized?: boolean },
      callback: (response: unknown) => void,
    ) => {
      if (!['example.com', 'docs.docker.com'].includes(url.hostname)) throw new Error('fixture: unexpected HTTPS target');
      if (options.rejectUnauthorized !== true || options.family !== 4) throw new Error('fixture: invalid pinned TLS options');
      (globalThis as FixtureGlobal).publicNetworkFixture.requests.push({ url: url.href, family: options.family, headers: options.headers });
      const request = Object.assign(new EventEmitter(), {
        end: () => {
          setImmediate(() => {
            const redirected = url.pathname === '/start';
            const failed = url.pathname === '/missing';
            const response = Object.assign(new EventEmitter(), {
              statusCode: redirected ? 302 : failed ? 404 : 200,
              headers: redirected ? { location: 'https://docs.docker.com/guide' } : { 'content-type': 'text/html; charset=utf-8' },
              destroy: (error: Error) => response.emit('error', error),
            });
            callback(response);
            response.emit(
              'data',
              Buffer.from(
                redirected
                  ? ''
                  : '<html><head><title>Controlled\n Public Fixture</title><link rel="preconnect" href="http://127.0.0.1"></head><body><h1>CONTROLLED NETWORK FIXTURE</h1><p>Captured body matches the displayed document.</p><script>window.fixtureExecuted=true</script><img src="https://example.com/secret-pixel"><iframe src="file:///etc/passwd"></iframe></body></html>',
              ),
            );
            response.emit('end');
          });
        },
      });
      return request;
    }) as typeof https.request;
  });

  const address = page.getByLabel('页面地址');
  await address.fill('https://example.com/start#section');
  await address.press('Enter');
  await expect.poll(async () => (await previewInfo(app)).url).toBe('https://docs.docker.com/guide');
  const capture = page.getByRole('button', { name: '加入空间', exact: true });
  await expect(capture).toBeEnabled();
  await expect(page.getByLabel('页面地址')).toHaveValue('https://docs.docker.com/guide');
  const previewDocument = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = (BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).webContents;
    return wc.executeJavaScript(
      '({title:document.title,text:document.querySelector("main pre").textContent,studio:typeof window.studio,require:typeof window.require,process:typeof window.process,executed:typeof window.fixtureExecuted,active:document.querySelectorAll("script,img,iframe,form,link").length})',
    );
  });
  expect(previewDocument).toEqual({
    title: 'Controlled Public Fixture',
    text: 'CONTROLLED NETWORK FIXTURE\n\nCaptured body matches the displayed document.',
    studio: 'undefined',
    require: 'undefined',
    process: 'undefined',
    executed: 'undefined',
    active: 0,
  });
  const before = await browserState(page);
  await capture.click();
  await expect(capture).toBeEnabled();
  const collection = await resourceCollection(page);
  expect(collection.resources).toHaveLength(1);
  const resource = collection.resources[0]!;
  expect(resource).toMatchObject({
    requestedUrl: 'https://example.com/start',
    url: 'https://docs.docker.com/guide',
    title: previewDocument.title,
    text: previewDocument.text,
    version: 1,
    page: before.page,
  });
  await capture.click();
  await expect(capture).toBeEnabled();
  expect(await resourceCollection(page)).toEqual(collection);
  await windowShots(app, page, 'public-document-controlled-redirect-saved');

  await address.fill('https://example.com/missing');
  await address.press('Enter');
  await expect.poll(async () => (await browserState(page)).loadError !== null).toBe(true);
  await expect(capture).toBeDisabled();
  expect((await browserState(page)).loadError?.description).toContain('HTTP 404');
  const staleCapture = await page.evaluate(async () => {
    const snapshot = await window.studio.workbench.getSnapshot();
    const workspace = snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
    const resource = workspace.resources.find((r) => r.kind === 'web')!;
    const result = await window.studio.workbench.command({
      commandId: crypto.randomUUID(),
      workspaceId: workspace.workspaceId,
      type: 'capturePublicResource',
      resourceId: resource.resourceId,
    });
    return result.ok ? 'unexpected success' : 'rejected';
  });
  expect(staleCapture).toBe('rejected');
  expect(await resourceCollection(page)).toEqual(collection);
  const network = await app.evaluate(() => (globalThis as FixtureGlobal).publicNetworkFixture);
  expect(network.requests.map((request) => request.url)).toEqual([
    'https://example.com/start',
    'https://docs.docker.com/guide',
    'https://example.com/missing',
  ]);
  await writeFile(
    path.join(screensDir, 'public-document-controlled-evidence.json'),
    JSON.stringify(
      {
        evidenceKind: 'controlled-network-fixture-real-electron-protocol-and-store',
        realPublicNetworkVerified: false,
        modelInvoked: false,
        previewDocument,
        resource,
        requestUrls: network.requests.map((request) => request.url),
        failedNavigationCapture: staleCapture,
      },
      null,
      2,
    ),
  );
});
