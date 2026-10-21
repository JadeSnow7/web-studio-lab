import { test, expect, type ElectronApplication } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchApp, target, workspaceSnapshot, workshopNavigate } from './helpers';
import { sourceTreeDigest } from './edu-import-fixture';

const run = promisify(execFile);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('real edu import, owned native pages, metadata and data persistence, cancellation and Workbench export', async () => {
  test.skip(process.env['WSL_EDU_LIVE'] !== '1', 'explicit task-exclusive edu sandbox authorization required; no model or Azure call');
  test.setTimeout(600_000);
  const sourceRoot = process.env['WSL_EDU_SOURCE_ROOT'];
  const evidenceRoot = process.env['WSL_EDU_EVIDENCE'];
  const expectedSha = process.env['WSL_EDU_EXPECTED_SHA256'];
  const sandbox = process.env['WSL_SBX_NAME'];
  const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
  if (!sourceRoot || !evidenceRoot || !/^[a-f0-9]{64}$/.test(expectedSha ?? '') || !sandbox?.startsWith('wsl-edu-'))
    throw new Error('explicit source root, expected digest, fresh evidence directory and task-exclusive sandbox required');
  await mkdir(evidenceRoot, { mode: 0o700 });
  const profile = process.env['WSL_EDU_PROFILE'] ?? path.join(evidenceRoot, 'profile');
  if (!path.isAbsolute(profile)) throw new Error('absolute task-exclusive Electron profile required');
  await mkdir(profile, { mode: 0o700 });
  const failures: string[] = [];
  const evidence: Record<string, unknown> = {
    scope: 'real-electron-main-service-sbx-edu',
    target,
    sandbox,
    sourceRoot,
    expectedSha,
    picker: 'Main native-dialog replies automated; source collector, IPC, AppService, guest and Browser are unmocked',
    notCovered: ['physical microphone', 'audio-track lifecycle', 'real Azure', 'agent-maintenance rounds', 'deployment'],
    startedAt: new Date().toISOString(),
    result: 'not_run',
  };
  const portMappings = async () => {
    const keeper = spawn(
      binary,
      ['exec', '-i', sandbox, 'python3', '-u', '-c', "import sys; print('EDU_PORT_CHECK_ACTIVE', flush=True); sys.stdin.buffer.read()"],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 },
    );
    const closed = new Promise<number | null>((resolve, reject) => {
      keeper.once('close', resolve);
      keeper.once('error', reject);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('port-check guest did not become active')), 30000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        keeper.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('EDU_PORT_CHECK_ACTIVE')) finish();
        });
        keeper.once('error', finish);
        keeper.once('close', () => finish(new Error('port-check guest closed before receipt')));
      });
      const result = await run(binary, ['ports', sandbox, '--json'], { timeout: 20000 });
      return JSON.parse(result.stdout) as Array<{ sandbox_port: number; host_port: number; host_ip: string }>;
    } finally {
      keeper.stdin.end();
      expect(await closed).toBe(0);
    }
  };
  const password = randomBytes(32).toString('base64url');
  const username = 'workbench-smoke-admin';
  type ProcessIdentity = { pid: number; startTime: string; group: number };
  const database = async (projectId: string, seed = false, expected: ProcessIdentity[] = []) => {
    if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('invalid isolated project identity');
    const root = '/home/agent/workspace/.wsl-apps/' + projectId;
    const program = await readFile(path.resolve('e2e/fixtures/edu-guest-audit.py'), 'utf8');
    const process = spawn(binary, ['exec', '-i', sandbox, root + '/.venv/bin/python', '-c', program, root], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    process.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      process.once('close', resolve);
      process.once('error', reject);
    });
    process.stdin.end(JSON.stringify({ seed, username, expected, ...(seed ? { password } : {}) }));
    expect(await closed, stderr.replaceAll(password, '[redacted]')).toBe(0);
    const result = JSON.parse(stdout) as {
      database: { inode: number; sha256: string; databaseMode: number; dataMode: number; adminCount: number };
      appProcesses: ProcessIdentity[];
      registeredProcessesRemaining: ProcessIdentity[];
    };
    expect(result.database).toMatchObject({ databaseMode: 0o600, dataMode: 0o700, adminCount: 1 });
    return result;
  };
  const sourceBefore = await sourceTreeDigest(sourceRoot, true);
  evidence['sourceBeforeSha256'] = sourceBefore;
  const baselinePorts = await portMappings();
  evidence['baselinePorts'] = baselinePorts;
  const captureProcess = (application: ElectronApplication) => {
    // Playwright disposes app.process() after close; retain the Node process handle now.
    const process = application.process();
    const exit =
      process.exitCode !== null || process.signalCode !== null
        ? Promise.resolve({ code: process.exitCode, signal: process.signalCode })
        : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
            process.once('exit', (code, signal) => resolve({ code, signal })),
          );
    return { process, pid: process.pid, exit };
  };
  const proveExit = async (owned: ReturnType<typeof captureProcess>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        owned.exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('owned Electron exit not confirmed')), 15000);
        }),
      ]);
      expect(outcome, 'owned Electron must exit normally').toEqual({ code: 0, signal: null });
      return { pid: owned.pid, ...outcome };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let { app, page } = await launchApp({ live: true, userData: profile });
  let owned = captureProcess(app);
  const ownedRuns = [owned];
  const state = async () => (await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')!;
  const waitState = async (expected: string) => {
    await expect
      .poll(
        async () => {
          const current = (await state()).managedApp;
          if (current?.state === 'failed' && expected !== 'failed') throw new Error('App failed: ' + current.error);
          return current?.state;
        },
        { timeout: 260000 },
      )
      .toBe(expected);
  };
  const selectSource = async (canceled: boolean) => {
    await app.evaluate(
      ({ dialog }, selection) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return selection;
        };
      },
      { canceled, filePaths: canceled ? [] : [sourceRoot] },
    );
  };
  try {
    evidence['electronVersions'] = await app.evaluate(() => process.versions);
    if (target === 'build') {
      const bundles: Record<string, string> = {};
      for (const file of ['apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.js', 'apps/service/out/index.cjs'])
        bundles[file] = hash(await readFile(path.resolve(file)));
      evidence['productBundles'] = bundles;
    }
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await selectSource(true);
    await page.getByRole('button', { name: '导入已有工程', exact: true }).click();
    await expect(page.getByRole('button', { name: '导入已有工程', exact: true })).toBeEnabled();
    expect((await state()).managedApp).toBeFalsy();
    evidence['pickerCancelled'] = true;
    await app.evaluate(({ dialog }) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = () => {
        dialog.showOpenDialog = original;
        return new Promise<Electron.OpenDialogReturnValue>((resolve) => {
          (globalThis as typeof globalThis & { __eduPicker?: typeof resolve }).__eduPicker = resolve;
        });
      };
    });
    await page.getByRole('button', { name: '导入已有工程', exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as typeof globalThis & { __eduPicker?: unknown }).__eduPicker))
      .toBe('function');
    await page.getByRole('button', { name: '取消导入', exact: true }).click();
    await app.evaluate((_electron, root) => {
      const scope = globalThis as typeof globalThis & { __eduPicker?: (selection: Electron.OpenDialogReturnValue) => void };
      if (!scope.__eduPicker) throw new Error('source picker is not pending');
      scope.__eduPicker({ canceled: false, filePaths: [root] });
      delete scope.__eduPicker;
    }, sourceRoot);
    await expect.poll(async () => (await state()).appImport?.phase).toBe('cancelled');
    expect((await state()).managedApp).toBeFalsy();
    evidence['lateSelectionCancelled'] = true;
    await selectSource(false);
    await page.getByRole('button', { name: '导入已有工程', exact: true }).click();
    await expect.poll(async () => (await state()).appImport?.phase).toBe('ready');
    const preview = (await state()).appImport!;
    expect(preview.preview?.sourceSha256).toBe(expectedSha);
    expect(preview.published).toBe(false);
    expect((await state()).app).toBeFalsy();
    expect((await state()).managedApp).toBeFalsy();
    expect(await portMappings()).toEqual(baselinePorts);
    expect(await sourceTreeDigest(sourceRoot, true)).toBe(sourceBefore);
    evidence['staticPreview'] = preview;
    await page.screenshot({ path: path.join(evidenceRoot, 'import-preview.png') });
    await page.getByRole('button', { name: '确认导入并启动', exact: true }).click();
    await waitState('running');
    await expect(page.getByRole('dialog', { name: '空间 App' })).not.toBeVisible();
    const imported = (await state()).managedApp!;
    expect(imported.profile?.projectKind).toBe('edu-web');
    expect(imported.sourceSha256).toBe(expectedSha);
    expect(imported.guestCwd).toBe('/home/agent/workspace/.wsl-apps/' + imported.projectId);
    evidence['imported'] = imported;
    const first = (await state()).managedApp!;
    expect(first.sourceSha256).toBe(expectedSha);
    await expect.poll(() => app.windows().some((view) => view.url().startsWith(first.url!)), { timeout: 15000 }).toBe(true);
    const browser = app.windows().find((view) => view.url().startsWith(first.url!))!;
    await expect(browser).toHaveURL(first.url! + '/student');
    await expect(browser.getByRole('heading', { name: '与管理员建立约定', exact: true })).toBeVisible();
    evidence['automaticStudentPage'] = true;
    await browser.screenshot({ path: path.join(evidenceRoot, 'import-opened-student.png') });
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '管理员页', exact: true }).click();
    await expect(browser.getByRole('heading', { name: '管理员登录', exact: true })).toBeVisible();
    const health = await browser.evaluate(async () => await (await fetch('/api/health')).json());
    expect(health).toEqual({
      ok: true,
      templateId: 'edu-web',
      templateVersion: '1.0.0',
      identity: {
        workspaceId: first.workspaceId,
        environmentId: 'sandbox',
        projectId: first.projectId,
        appInstanceId: first.appInstanceId,
      },
    });
    expect(await browser.evaluate(() => ({ node: typeof process, studio: typeof window.studio }))).toEqual({
      node: 'undefined',
      studio: 'undefined',
    });
    await browser.screenshot({ path: path.join(evidenceRoot, 'administrator-login.png') });
    const seeded = await database(first.projectId, true);
    expect(seeded.appProcesses.length).toBeGreaterThan(0);
    evidence['appProcessesWhileRunning'] = seeded.appProcesses;
    await browser.getByLabel('管理员账户', { exact: true }).fill(username);
    await browser.getByLabel('密码', { exact: true }).fill(password);
    await browser.getByRole('button', { name: '登录', exact: true }).click();
    await expect(browser.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    evidence['adminLogin'] = true;
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '学生页', exact: true }).click();
    await expect(browser).toHaveURL(first.url! + '/student');
    await expect(browser.getByRole('heading', { name: '听一听，再读一遍。', exact: true })).toBeVisible();
    await expect(browser.getByRole('heading', { name: '与管理员建立约定', exact: true })).toBeVisible();
    // This import acceptance does not request microphone access or exercise recording.
    await expect
      .poll(async () => (await state()).resources.find((item) => item.appProjectId === first.projectId)?.preview?.page.url)
      .toBe(browser.url());
    const resource = (await state()).resources.find((item) => item.appProjectId === first.projectId)!;
    expect(resource).toMatchObject({ kind: 'web', title: (await state()).app?.name, environmentId: 'sandbox' });
    expect(resource.preview?.page.url).toBe(browser.url());
    const geometry = await app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const view = window.contentView.children.find((candidate) => (candidate as Electron.WebContentsView).webContents?.id === id) as
        Electron.WebContentsView | undefined;
      return view ? { visible: view.getVisible(), bounds: view.getBounds(), url: view.webContents.getURL() } : null;
    }, resource.preview!.page.webContentsId);
    expect(geometry?.visible).toBe(true);
    expect(geometry!.bounds.width).toBeGreaterThan(100);
    evidence['first'] = { app: first, health, geometry, microphone: 'not_requested' };
    await browser.screenshot({ path: path.join(evidenceRoot, 'student-page.png') });
    await browser.reload();
    await expect(browser.getByRole('heading', { name: '与管理员建立约定', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '管理员页', exact: true }).click();
    await expect(browser).toHaveURL(first.url! + '/');
    await expect(browser.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '停止应用', exact: true }).click();
    await waitState('stopped');
    expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
    expect(await portMappings()).toEqual(baselinePorts);
    await expect(fetch(first.url! + '/api/health', { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    const stoppedAudit = await database(first.projectId, false, seeded.appProcesses);
    expect(stoppedAudit).toMatchObject({ appProcesses: [], registeredProcessesRemaining: [] });
    const persisted = stoppedAudit.database;
    evidence['databaseBeforeRestart'] = persisted;
    evidence['stoppedProcessAudit'] = stoppedAudit;
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitState('running');
    const second = (await state()).managedApp!;
    expect(second.appInstanceId).not.toBe(first.appInstanceId);
    expect(second.profile).toEqual(imported.profile);
    const beforeExit = await database(second.projectId);
    expect(beforeExit.appProcesses.length).toBeGreaterThan(0);
    evidence['appProcessesBeforeExit'] = beforeExit.appProcesses;
    await app.close();
    evidence['restartExit'] = await proveExit(owned);
    expect(await portMappings()).toEqual(baselinePorts);
    ({ app, page } = await launchApp({ live: true, userData: profile }));
    owned = captureProcess(app);
    ownedRuns.push(owned);
    await workshopNavigate(page, '空间');
    const restored = (await state()).managedApp!;
    expect(restored).toMatchObject({
      projectId: first.projectId,
      appInstanceId: null,
      state: 'stopped',
      url: null,
      cleanupConfirmed: true,
      profile: imported.profile,
    });
    expect(await portMappings()).toEqual(baselinePorts);
    const restoredAudit = await database(first.projectId, false, beforeExit.appProcesses);
    expect(restoredAudit).toMatchObject({ appProcesses: [], registeredProcessesRemaining: [], database: persisted });
    await expect(page.getByText('unavailable: 应用实例已停止或需要重新启动', { exact: true })).toBeHidden();
    evidence['restoredProcessAudit'] = restoredAudit;
    evidence['restored'] = restored;
    evidence['databasePreserved'] = true;
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '导出源码', exact: true }).click();
    await expect.poll(async () => (await state()).appExport?.path, { timeout: 30000 }).toBeTruthy();
    const exported = (await state()).appExport!;
    const manifest = JSON.parse(await readFile(exported.manifestPath!, 'utf8'));
    expect(manifest).toMatchObject({
      sourceKind: 'workbench-export',
      projectKind: 'edu-web',
      profileVersion: 1,
      sourceSha256: expectedSha,
      workbench: { workspaceId: first.workspaceId, projectId: first.projectId, environmentId: 'sandbox' },
    });
    expect(manifest.workbench.importBase).toEqual(imported.profile?.projectKind === 'edu-web' ? imported.profile.source : null);
    expect(hash(JSON.stringify(manifest.files))).toBe(exported.sha256);
    for (const file of manifest.files as Array<{ path: string; sha256: string; bytes: number }>) {
      expect(
        file.path.split('/').some((part) => ['..', '.env', '.venv', '.data', 'node_modules', 'dist', '__pycache__'].includes(part)),
      ).toBe(false);
      const destination = path.resolve(exported.path, file.path);
      expect(destination.startsWith(exported.path + path.sep)).toBe(true);
      expect((await lstat(destination)).isSymbolicLink()).toBe(false);
      const bytes = await readFile(destination);
      expect(hash(bytes)).toBe(file.sha256);
      expect(bytes.length).toBe(file.bytes);
    }
    evidence['exported'] = exported;
    evidence['exportManifest'] = manifest;
    await page.screenshot({ path: path.join(evidenceRoot, 'export-dialog.png') });
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消启动', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '取消启动', exact: true }).click();
    await waitState('stopped');
    expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
    expect(await portMappings()).toEqual(baselinePorts);
    const cancelledAudit = await database(first.projectId);
    expect(cancelledAudit).toMatchObject({ appProcesses: [], registeredProcessesRemaining: [] });
    evidence['cancelledProcessAudit'] = cancelledAudit;
    evidence['startupCancelled'] = true;
    expect(await sourceTreeDigest(sourceRoot, true)).toBe(sourceBefore);
    evidence['sourceUnchanged'] = true;
    evidence['result'] = 'passed';
  } catch (error) {
    evidence['result'] = 'failed';
    const message = String(error).replaceAll(password, '[redacted]');
    evidence['error'] = message;
    failures.push(message);
  } finally {
    const cleanupErrors: Array<{ phase: string; message: string }> = [];
    const cleanupFailure = (phase: string, error: unknown) => {
      evidence['result'] = 'failed';
      const message = String(error).replaceAll(password, '[redacted]');
      cleanupErrors.push({ phase, message });
      failures.push(phase + ': ' + message);
    };
    try {
      if (owned.process.exitCode === null && owned.process.signalCode === null) {
        const current = (await state()).managedApp;
        if (current && !current.cleanupConfirmed) {
          const stopped = await page.evaluate(async () =>
            window.studio.workbench.command({ type: 'stopApp', workspaceId: 'taskflow-demo', commandId: crypto.randomUUID() }),
          );
          expect(stopped.ok, 'explicit teardown stop must succeed').toBe(true);
        }
        const final = (await state()).managedApp;
        evidence['final'] = final;
        if (final) expect(final.cleanupConfirmed).toBe(true);
      }
    } catch (error) {
      cleanupFailure('stop-and-snapshot', error);
    } finally {
      // Even a failed/closed renderer must not skip the owned application close attempt.
      try {
        await app.close();
      } catch (error) {
        cleanupFailure('close', error);
      }
    }
    const exits = [];
    for (const run of ownedRuns) {
      try {
        exits.push(await proveExit(run));
      } catch (error) {
        cleanupFailure('electron-exit', error);
        exits.push({ pid: run.pid, code: run.process.exitCode, signal: run.process.signalCode, confirmed: false });
      }
    }
    evidence['ownedElectronExits'] = exits;
    try {
      evidence['finalPorts'] = await portMappings();
      expect(evidence['finalPorts']).toEqual(baselinePorts);
    } catch (error) {
      cleanupFailure('port-audit', error);
    }
    try {
      evidence['sourceAfterSha256'] = await sourceTreeDigest(sourceRoot, true);
      expect(evidence['sourceAfterSha256'], 'selected source changed during live import').toBe(sourceBefore);
    } catch (error) {
      cleanupFailure('source-audit', error);
    }
    evidence['cleanupErrors'] = cleanupErrors;
    evidence['endedAt'] = new Date().toISOString();
    await writeFile(path.join(evidenceRoot, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' });
    console.log('EDU_APP_EVIDENCE', evidenceRoot);
  }
  expect(failures).toEqual([]);
});
