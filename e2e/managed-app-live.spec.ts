import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { target, launchApp, workspaceSnapshot, workshopNavigate } from './helpers';

test('real sbx standard app through product Browser, persistence, export and cancellation', async () => {
  test.skip(process.env['WSL_APP_LIVE'] !== '1', 'explicit live sbx authorization required; no model is called');
  test.setTimeout(600_000);
  const evidenceRoot = path.resolve(process.env['WSL_APP_EVIDENCE'] ?? `test-results/managed-app-${randomUUID()}`);
  const profile = path.join(evidenceRoot, 'profile');
  await mkdir(evidenceRoot, { recursive: true });
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), profile, sandbox: process.env['WSL_SBX_NAME'] };
  let { app, page } = await launchApp({ live: true, userData: profile });
  evidence['launchEnvironment'] = await app.evaluate(() => ({
    path: process.env.PATH,
    injected: Object.keys(process.env).filter((name) => name.startsWith('WSL_')),
  }));
  if (target === 'packaged') {
    expect(evidence['launchEnvironment']).toEqual({ path: '/usr/bin:/bin:/usr/sbin:/sbin', injected: [] });
    const saved = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
    expect(saved.config.sbxBinary).toMatch(/\/Sbx\.app\/Contents\/MacOS\/sbx$/);
    evidence['runtimeConfig'] = saved.config;
  }
  const portMappings = async () => {
    const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
    const sandbox = process.env['WSL_SBX_NAME']!;
    // sbx can return [] while idle even when mappings persist; keep this guest awake while checking.
    const keeper = spawn(
      binary,
      ['exec', '-i', sandbox, 'python3', '-u', '-c', "import sys; print('WSL_PORT_CHECK_ACTIVE', flush=True); sys.stdin.buffer.read()"],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      keeper.once('error', reject);
      keeper.once('close', resolve);
    });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Port-check guest did not become active')), 30000);
        keeper.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('WSL_PORT_CHECK_ACTIVE')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        keeper.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        keeper.once('close', () => {
          clearTimeout(timeout);
          reject(new Error('Port-check guest exited before active receipt'));
        });
      });
      const result = await promisify(execFile)(binary, ['ports', sandbox, '--json'], { timeout: 20000 });
      return JSON.parse(result.stdout) as { host_ip: string; host_port: number; sandbox_port: number; protocol: string }[];
    } finally {
      keeper.stdin.end();
      expect(await closed).toBe(0);
    }
  };
  const state = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
  const waitState = async (value: string) => {
    const deadline = Date.now() + 260000;
    while (Date.now() < deadline) {
      const current = (await state()).managedApp;
      if (current?.state === value) return;
      if (current?.state === 'failed' && value !== 'failed') throw new Error('App failed: ' + current.error);
      await page.waitForTimeout(250);
    }
    throw new Error('App state timed out: ' + JSON.stringify((await state()).managedApp));
  };
  try {
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    await waitState('created');
    evidence['created'] = (await state()).managedApp;
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitState('running');
    const first = (await state()).managedApp!;
    evidence['first'] = first;
    const browser = await expect
      .poll(async () => app.windows().some((p) => p.url().startsWith(first.url!)), { timeout: 15000 })
      .toBe(true)
      .then(() => app.windows().find((p) => p.url().startsWith(first.url!))!);
    await expect(browser.getByRole('heading', { name: '从这里开始构建' })).toBeVisible();
    await expect(browser.getByTestId('app-instance-id')).toHaveText(first.appInstanceId!);
    const health = await browser.evaluate(async () => await (await fetch('/api/health')).json());
    expect(health.identity).toEqual({
      workspaceId: first.workspaceId,
      environmentId: 'sandbox',
      projectId: first.projectId,
      appInstanceId: first.appInstanceId,
    });
    const native = (await state()).resources.find((r) => r.appProjectId === first.projectId)!;
    expect(native.preview?.page?.url).toBe(browser.url());
    const geometry = await app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const view = window.contentView.children.find((candidate) => (candidate as Electron.WebContentsView).webContents?.id === id) as
        Electron.WebContentsView | undefined;
      return view
        ? { visible: view.getVisible(), bounds: view.getBounds(), webContentsId: view.webContents.id, url: view.webContents.getURL() }
        : null;
    }, native.preview!.page.webContentsId);
    expect(geometry?.visible).toBe(true);
    expect(geometry!.bounds.width).toBeGreaterThan(100);
    expect(geometry!.bounds.height).toBeGreaterThan(100);
    const workspace = await state();
    const activePane = (function find(layout: typeof workspace.layout): { paneId: string; tabId: string | null } | undefined {
      return layout.kind === 'pane'
        ? layout.paneId === workspace.activePaneId
          ? layout
          : undefined
        : (find(layout.first) ?? find(layout.second));
    })(workspace.layout);
    expect(workspace.tabs.find((tab) => tab.tabId === activePane?.tabId)?.targetRef.resourceId).toBe(native.resourceId);
    evidence['nativeBrowser'] = { resource: native, health, geometry, activePane };
    await browser.screenshot({ path: path.join(evidenceRoot, 'native-browser.png') });
    await page.screenshot({ path: path.join(evidenceRoot, 'workbench-renderer.png') });
    const windowPng = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
    );
    await writeFile(path.join(evidenceRoot, 'workbench-window.png'), Buffer.from(windowPng, 'base64'));
    const pauseMs = Math.min(60000, Math.max(0, Number(process.env['WSL_APP_SCREEN_PAUSE_MS'] ?? 0)));
    if (pauseMs) {
      console.log('MANAGED_APP_SCREEN_READY', JSON.stringify({ url: first.url, webContentsId: native.preview!.page.webContentsId }));
      await page.waitForTimeout(pauseMs);
    }
    const nonce = randomUUID();
    const persistence = await browser.evaluate(async (nonce) => {
      const request = async (url: string, method = 'GET', body?: unknown) => {
        const response = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      };
      const a = await request('/api/dev/session', 'POST', { userId: 'A' });
      const writeA = await request('/api/kv/welcome', 'PUT', { value: nonce });
      const b = await request('/api/dev/session', 'POST', { userId: 'B' });
      const readB = await request('/api/kv/welcome');
      const writeB = await request('/api/kv/welcome', 'PUT', { value: 'B-' + nonce });
      return { a, writeA, b, readB, writeB };
    }, nonce);
    expect(persistence.a.status).toBe(200);
    expect(persistence.writeA.body.value).toBe(nonce);
    expect(persistence.b.status).toBe(200);
    expect(persistence.readB.body.value).toBe('Ready');
    expect(persistence.writeB.body.value).toBe('B-' + nonce);
    evidence['storageBefore'] = persistence;
    await page.getByRole('button', { name: '停止应用', exact: true }).click();
    await waitState('stopped');
    expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
    const firstStoppedPorts = await portMappings();
    evidence['firstStoppedPorts'] = firstStoppedPorts;
    expect(firstStoppedPorts.some((port) => port.sandbox_port === first.guestPort)).toBe(false);
    await expect
      .poll(async () =>
        fetch(first.url! + '/api/health', { signal: AbortSignal.timeout(1500) }).then(
          () => false,
          () => true,
        ),
      )
      .toBe(true);
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitState('running');
    const second = (await state()).managedApp!;
    expect(second.projectId).toBe(first.projectId);
    expect(second.appInstanceId).not.toBe(first.appInstanceId);
    const restartedPorts = await portMappings();
    evidence['restartedPorts'] = restartedPorts;
    expect(restartedPorts.filter((port) => port.sandbox_port === second.guestPort)).toHaveLength(1);
    if (first.guestPort !== second.guestPort) expect(restartedPorts.some((port) => port.sandbox_port === first.guestPort)).toBe(false);
    await expect.poll(async () => app.windows().some((p) => p.url().startsWith(second.url!)), { timeout: 15000 }).toBe(true);
    const restarted = app.windows().find((p) => p.url().startsWith(second.url!))!;
    await expect(restarted.getByTestId('app-instance-id')).toHaveText(second.appInstanceId!);
    const persisted = await restarted.evaluate(async () => {
      const values = [];
      for (const userId of ['A', 'B']) {
        const session = await fetch('/api/dev/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        if (!session.ok) throw new Error('session failed');
        values.push(await (await fetch('/api/kv/welcome')).json());
      }
      return values;
    });
    expect(persisted.map((v) => v.value)).toEqual([nonce, 'B-' + nonce]);
    evidence['restart'] = { second, persisted };
    // Close the actual running workbench; service shutdown must revoke its own mapping before disconnecting.
    await app.close();
    const windowClosedPorts = await portMappings();
    expect(windowClosedPorts.some((port) => port.sandbox_port === second.guestPort)).toBe(false);
    evidence['windowClosedPorts'] = windowClosedPorts;
    ({ app, page } = await launchApp({ live: true, userData: profile }));
    await workshopNavigate(page, '空间');
    const restored = (await state()).managedApp!;
    expect(restored.state).toBe('stopped');
    expect(restored.url).toBeNull();
    expect(restored.projectId).toBe(first.projectId);
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitState('running');
    const third = (await state()).managedApp!;
    expect(third.appInstanceId).not.toBe(second.appInstanceId);
    await expect.poll(async () => app.windows().some((p) => p.url().startsWith(third.url!)), { timeout: 15000 }).toBe(true);
    const reopened = app.windows().find((p) => p.url().startsWith(third.url!))!;
    await expect(reopened.getByTestId('app-instance-id')).toHaveText(third.appInstanceId!);
    const afterWindowClose = await reopened.evaluate(async () => {
      const values = [];
      for (const userId of ['A', 'B']) {
        const response = await fetch('/api/dev/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        if (!response.ok) throw new Error('session failed');
        values.push(await (await fetch('/api/kv/welcome')).json());
      }
      return values;
    });
    expect(afterWindowClose.map((v) => v.value)).toEqual([nonce, 'B-' + nonce]);
    evidence['windowRestored'] = { restored, third, persisted: afterWindowClose };
    await page.getByRole('button', { name: '停止应用', exact: true }).click();
    await waitState('stopped');
    const secondStoppedPorts = await portMappings();
    evidence['secondStoppedPorts'] = secondStoppedPorts;
    expect(secondStoppedPorts.some((port) => port.sandbox_port === third.guestPort)).toBe(false);
    expect(secondStoppedPorts.some((port) => port.sandbox_port === second.guestPort)).toBe(false);
    await page.getByRole('button', { name: '导出源码', exact: true }).click();
    await expect.poll(async () => (await state()).appExport?.path, { timeout: 30000 }).toBeTruthy();
    const exported = (await state()).appExport!;
    const manifest = JSON.parse(await readFile(exported.manifestPath ?? `${exported.path}.manifest.json`, 'utf8'));
    expect(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex')).toBe(exported.sha256);
    for (const file of manifest.files as { path: string; base64: string }[])
      expect((await readFile(path.join(exported.path, file.path))).toString('base64')).toBe(file.base64);
    expect(manifest.files.some((f: { path: string }) => f.path === 'package-lock.json')).toBe(true);
    evidence['export'] = exported;
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消启动', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '取消启动', exact: true }).click();
    await waitState('stopped');
    expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
    evidence['cancelled'] = (await state()).managedApp;
    const finalAwakePorts = await portMappings();
    for (const owned of [first.guestPort, second.guestPort, third.guestPort])
      expect(finalAwakePorts.some((port) => port.sandbox_port === owned)).toBe(false);
    evidence['finalAwakePorts'] = finalAwakePorts;
    evidence['passed'] = true;
  } catch (error) {
    evidence['error'] = String(error);
    throw error;
  } finally {
    try {
      const current = await state();
      evidence['final'] = current.managedApp;
      if (current.managedApp && !current.managedApp.cleanupConfirmed)
        await page.evaluate(async () =>
          window.studio.workbench.command({ type: 'stopApp', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
        );
    } finally {
      await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
      console.log('MANAGED_APP_EVIDENCE', evidenceRoot);
      await app.close();
    }
  }
});
