import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppOperationReceiptSchema, type WorkbenchCommand } from '../packages/protocol/src';
import { launchApp, workspaceSnapshot, workshopNavigate } from './helpers';
import { installDataGate } from './fixtures/app-control-data-gate';

const execute = promisify(execFile);
const sbx = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
const sandbox = process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006';
const source = path.resolve('templates/standard-app');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const guest = (args: string[]) => execute(sbx, ['exec', sandbox, ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
const fileRead = async (file: string) =>
  (
    await guest([
      'python3',
      '-I',
      '-c',
      'import pathlib,sys; p=pathlib.Path(sys.argv[1]); print(p.read_text() if p.exists() else "null")',
      file,
    ])
  ).stdout;
const fileWrite = (file: string, content: string) =>
  guest([
    'python3',
    '-I',
    '-c',
    'import pathlib,sys,base64; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(sys.argv[2]))',
    file,
    Buffer.from(content).toString('base64'),
  ]);
const ports = async () =>
  JSON.parse((await execute(sbx, ['ports', sandbox, '--json'], { timeout: 20_000 })).stdout) as { sandbox_port: number }[];

for (const mode of ['automatic', 'manual', 'failure'] as const)
  test(`real backend ${mode} cancellation keeps App alive until operation termination is reconciled`, async () => {
    test.skip(process.env['WSL_APP_CONTROL_DATA_CANCEL_LIVE'] !== '1', 'explicit real model and sandbox authorization required');
    test.setTimeout(900_000);
    const nonce = randomUUID();
    const evidence = path.resolve(process.env['WSL_APP_CONTROL_DATA_CANCEL_EVIDENCE'] ?? 'test-results/app-control-data-cancel-live', mode);
    await mkdir(evidence, { recursive: true });
    const profile = await mkdtemp(path.join(tmpdir(), 'wsl-data-cancel-'));
    const gateDir = `/tmp/wsl-data-cancel-${nonce}`;
    const operation = mode === 'manual' ? 'reset' : 'seed';
    const { app, page } = await launchApp({ live: true, userData: profile });
    const electron = app.process();
    const results: Record<string, unknown> = { nonce, mode, profile, sandbox, gateDir };
    const cleanupErrors: string[] = [];
    const save = () => writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    const space = async () => (await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')!;
    const command = (input: Omit<WorkbenchCommand, 'workspaceId' | 'commandId'> & Record<string, unknown>) =>
      page.evaluate((input) => window.studio.workbench.command(input as never), {
        ...input,
        workspaceId: 'taskflow-demo',
        commandId: randomUUID(),
      });
    const requireCommand = async (input: Parameters<typeof command>[0]) => {
      const reply = await command(input);
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
    };
    const waitApp = async (state: string) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const current = (await space()).managedApp;
        if (current?.state === state) return current;
        if (current?.state === 'failed') throw new Error(`App failed while waiting for ${state}: ${current.error}`);
        await page.waitForTimeout(500);
      }
      throw new Error(`timed out waiting for ${state}: ${JSON.stringify((await space()).managedApp)}`);
    };
    const pending = async () =>
      JSON.parse(await readFile(path.join(profile, 'app-control/pending.json'), 'utf8')) as {
        version: number;
        operations: { operationId: string; runId: string; appInstanceId: string }[];
      };
    let cwd: string | undefined;
    let runId: string | undefined;
    let ownedPort: number | undefined;
    let failure: unknown;
    const beforePorts = await ports();
    try {
      await workshopNavigate(page, '空间');
      await page.getByRole('button', { name: '新建 App', exact: true }).click();
      await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
      const createForm = page.getByRole('dialog', { name: '创建 App', exact: true });
      await createForm.getByLabel('App 名称').fill('Live 标准应用');
      await createForm.getByRole('button', { name: '保存 App' }).click();
      await expect(createForm).not.toBeVisible();
      await page.getByRole('button', { name: '管理 App', exact: true }).click();
      cwd = (await waitApp('created')).guestCwd;
      if (!cwd.startsWith('/home/agent/workspace/.wsl-apps/') || cwd.split('/').length !== 6)
        throw new Error('Unexpected generated project ownership');
      const original = await readFile(path.join(source, 'server/agent/operations.ts'), 'utf8');
      const patched = installDataGate(original, gateDir, nonce);
      await writeFile(path.join(evidence, 'fixture-operations.ts.txt'), patched);
      results['fixtureOperationsSha256'] = digest(patched);
      await fileWrite(`${cwd}/server/agent/operations.ts`, patched);
      if (mode === 'failure') {
        const routes = await readFile(path.join(source, 'server/agent/routes.ts'), 'utf8');
        const needle = "operation === 'seed' ? seed(database) : resetDatabase(database)";
        if (!routes.includes(needle)) throw new Error('Real failure insertion point changed');
        const changed = routes.replace(
          needle,
          "operation === 'seed' ? options.appInstanceId === process.env.WSL_APP_INSTANCE_ID ? database.client.query('DROP TABLE records').then(() => seed(database)) : seed(database) : resetDatabase(database)",
        );
        await fileWrite(`${cwd}/server/agent/routes.ts`, changed);
        await writeFile(path.join(evidence, 'fixture-routes.ts.txt'), changed);
      }
      results['manifestPreparation'] = 'Managed start imports dependencies then runs build:agent to generate manifest and build stamp';
      await page.getByRole('button', { name: '启动应用', exact: true }).click();
      const running = await waitApp('running');
      const generatedManifest = JSON.parse(await fileRead(`${cwd}/agent/app.manifest.json`)) as { sourceRevision: string };
      const generatedBuild = JSON.parse(await fileRead(`${cwd}/dist/agent-build.json`)) as { sourceRevision: string };
      expect(generatedManifest.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(generatedBuild.sourceRevision).toBe(generatedManifest.sourceRevision);
      results['managedStartSourceRevision'] = generatedManifest.sourceRevision;
      ownedPort = running.guestPort ?? undefined;
      results['appBefore'] = running;
      const runtimeBefore = JSON.parse(await fileRead(`${cwd}/.data/pglite.runtime.json`)) as {
        pid: number;
        port: number;
        appInstanceId: string;
      };
      expect(runtimeBefore.pid).toBeGreaterThan(0);
      expect(runtimeBefore).toMatchObject({ port: running.guestPort, appInstanceId: running.appInstanceId });
      results['runtimeBefore'] = runtimeBefore;
      await page.getByRole('dialog', { name: '空间 App' }).getByRole('button', { name: '关闭', exact: true }).click();
      const sessionId = (await space()).sessions[0]!.sessionId;
      await requireCommand({ type: 'locateSession', sessionId });
      const script = `import subprocess,json,os\nos.chdir(${JSON.stringify(cwd)})\np=subprocess.run(['wsl-app','status','{}'],capture_output=True,text=True,timeout=65)\nassert p.returncode==0,p.stdout\ns=json.loads(p.stdout)['data']['app']\np=subprocess.run(['wsl-app','data.${operation}',json.dumps({'appInstanceId':s['appInstanceId']${operation === 'reset' ? ", 'confirm':'reset-instance-data'" : ''}})],capture_output=True,text=True,timeout=65)\nprint(p.stdout)\nassert p.returncode==0,p.stdout`;
      await requireCommand({
        type: 'confirmTask',
        sessionId,
        goal: `真实数据取消验收，只在 ${cwd} 通过普通命令工具原样执行下方 Python 脚本。应用已准备并运行；禁止改源码、重启、停止、读取凭据、联网或申请权限。只允许 status 与一次 data.${operation}，不要重试。操作在后端等待 Host，Host 将点击产品取消按钮。保持现有 sandbox 权限，10分钟内一次run。\npython3 - <<'PY'\n${script}\nPY`,
        allowedScopes: operation === 'reset' ? ['app.data.reset'] : [],
        acceptance: ['真实后端操作登记后取消并核对'],
        targetRef: null,
        appId: null,
        captureId: null,
      });
      const taskVersionId = (await space()).sessions.find((session) => session.sessionId === sessionId)!.taskVersions.at(-1)!.taskVersionId;
      await requireCommand({ type: 'startRun', sessionId, taskVersionId });
      runId = (await space()).runs.at(-1)!.runId;
      results['runId'] = runId;
      await expect
        .poll(async () => JSON.parse(await fileRead(gateDir + '/entered.json')), { timeout: 600_000, intervals: [500, 1000] })
        .not.toBeNull();
      const entered = JSON.parse(await fileRead(gateDir + '/entered.json')) as {
        nonce: string;
        operationId: string;
        operation: string;
        appInstanceId: string;
        pid: number;
      };
      results['entered'] = entered;
      expect(entered).toMatchObject({ nonce, operation, appInstanceId: running.appInstanceId, pid: runtimeBefore.pid });
      expect((await pending()).operations).toContainEqual(
        expect.objectContaining({ operationId: entered.operationId, runId, appInstanceId: running.appInstanceId }),
      );
      const session = page.getByRole('region', { name: 'Agent 会话内容' });
      await session.getByRole('button', { name: '取消回复', exact: true }).click();
      results['cancelAt'] = Date.now();
      await expect
        .poll(async () => (await space()).runs.find((run) => run.runId === runId)?.executorState, { timeout: 20_000 })
        .toMatchObject({ state: 'cancelled', cleanupPending: false });
      const cancelledModel = (await space()).runs.find((run) => run.runId === runId)!;
      expect(cancelledModel.state).toBe('cancelling');
      expect(cancelledModel.appCleanupPending).toBe(true);
      expect(cancelledModel.conversation?.cleanupPending).toBe(true);
      results['modelStoppedBackendRunning'] = cancelledModel;
      const afterCancel = (await space()).managedApp!;
      expect(afterCancel).toMatchObject({ state: 'running', appInstanceId: running.appInstanceId });
      expect(JSON.parse(await fileRead(`${cwd}/.data/pglite.runtime.json`)).pid).toBe(runtimeBefore.pid);
      for (const type of ['startApp', 'exportApp'] as const) {
        const blocked = await command({ type });
        results[`blocked-${type}`] = blocked;
        expect(blocked.ok).toBe(false);
      }
      await page.screenshot({ path: path.join(evidence, 'pending.png') });
      const focusIdentity = () =>
        page.evaluate(() => {
          const element = document.activeElement;
          return element
            ? {
                tag: element.tagName,
                id: element.id,
                testid: element.getAttribute('data-testid'),
                label: element.getAttribute('aria-label'),
                text: element.tagName === 'BUTTON' ? element.textContent?.trim() : null,
              }
            : null;
        });
      let busyFocus: Awaited<ReturnType<typeof focusIdentity>> | undefined;
      if (mode === 'manual') {
        await expect(session.getByRole('button', { name: '重新核对', exact: true })).toBeEnabled({ timeout: 45_000 });
        results['automaticBudgetElapsedMs'] = Date.now() - (results['cancelAt'] as number);
        expect(results['automaticBudgetElapsedMs']).toBeGreaterThanOrEqual(29_000);
        expect(results['automaticBudgetElapsedMs']).toBeLessThan(45_000);
        expect((await pending()).operations).toHaveLength(1);
        expect((await space()).runs.find((run) => run.runId === runId)?.state).toBe('cancelling');
        const window = await app.browserWindow(page);
        const originalBounds = await window.evaluate((window) => window.getBounds());
        await window.evaluate((window) => window.setSize(820, 700));
        const pendingMessage = session.getByText('模型已停止，App 数据操作仍待确认', { exact: true });
        await expect(pendingMessage).toBeVisible();
        const retry = session.getByRole('button', { name: '重新核对', exact: true });
        await retry.focus();
        expect(await retry.evaluate((element) => document.activeElement === element)).toBe(true);
        results['focusBeforeKeyboardReconcile'] = await focusIdentity();
        await page.keyboard.press('Enter');
        await expect(retry).toBeDisabled();
        await expect.poll(async () => (await space()).runs.find((run) => run.runId === runId)?.cleanupReconciling).toBe(true);
        // A second keyboard activation of a disabled button must not dispatch another reconcile.
        await page.keyboard.press('Enter');
        await expect(retry).toBeDisabled();
        expect((await space()).runs.find((run) => run.runId === runId)?.cleanupReconciling).toBe(true);
        expect((await pending()).operations.map((operation) => operation.operationId)).toEqual([entered.operationId]);
        await expect(pendingMessage).toBeVisible();
        const textBox = await pendingMessage.boundingBox();
        expect(textBox).not.toBeNull();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(textBox!.width).toBeGreaterThan(120);
        expect(textBox!.x).toBeGreaterThanOrEqual(0);
        expect(textBox!.y).toBeGreaterThanOrEqual(0);
        expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(viewport.width);
        expect(textBox!.y + textBox!.height).toBeLessThanOrEqual(viewport.height);
        busyFocus = await focusIdentity();
        results['focusWhileReconciling'] = busyFocus;
        results['narrowWindowBounds'] = await window.evaluate((window) => window.getBounds());
        await page.screenshot({ path: path.join(evidence, 'manual-keyboard-reconciling-narrow.png') });
        await window.evaluate((window, bounds) => window.setBounds(bounds), originalBounds);
      }
      await fileWrite(gateDir + '/release', nonce);
      await expect.poll(async () => JSON.parse(await fileRead(gateDir + '/terminal.json')), { timeout: 20_000 }).not.toBeNull();
      const terminal = JSON.parse(await fileRead(gateDir + '/terminal.json')) as { nonce: string; receipt: unknown; pid: number };
      const receipt = AppOperationReceiptSchema.parse(terminal.receipt);
      results['terminal'] = terminal;
      expect(receipt).toMatchObject({
        operationId: entered.operationId,
        appInstanceId: running.appInstanceId,
        operation,
        state: mode === 'failure' ? 'failed' : 'succeeded',
      });
      expect(terminal.pid).toBe(runtimeBefore.pid);
      await expect
        .poll(
          async () => {
            const run = (await space()).runs.find((run) => run.runId === runId)!;
            return { state: run.state, pending: run.conversation?.cleanupPending };
          },
          { timeout: 35_000 },
        )
        .toEqual({ state: 'cancelled', pending: false });
      if (mode === 'manual') {
        const afterFocus = await focusIdentity();
        results['focusAfterReconcile'] = afterFocus;
        // Removing the disabled, focused retry button can naturally return DOM focus to body.
        if (busyFocus?.tag === 'BUTTON' && busyFocus.text === '重新核对')
          expect(afterFocus === null || afterFocus.tag === 'BODY' || JSON.stringify(afterFocus) === JSON.stringify(busyFocus)).toBe(true);
        else expect(afterFocus).toEqual(busyFocus);
        await expect(session.getByRole('button', { name: '重新核对', exact: true })).toHaveCount(0);
      }
      expect((await pending()).operations).toEqual([]);
      expect((await space()).managedApp).toMatchObject({ state: 'running', appInstanceId: running.appInstanceId });
      expect(JSON.parse(await fileRead(`${cwd}/.data/pglite.runtime.json`)).pid).toBe(runtimeBefore.pid);
      results['appReconciledStillRunning'] = (await space()).managedApp;
      results['runtimeReconciledStillRunning'] = JSON.parse(await fileRead(`${cwd}/.data/pglite.runtime.json`));
      await page.screenshot({ path: path.join(evidence, 'reconciled.png') });
      await requireCommand({ type: 'stopApp' });
      await waitApp('stopped');
      await requireCommand({ type: 'exportApp' });
      const exported = (await space()).appExport!;
      const sourceArchive = path.join(evidence, 'owned-project-export.tar.gz');
      await execute('/usr/bin/tar', ['-czf', sourceArchive, '-C', exported.path, '.'], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      results['sourceArchive'] = sourceArchive;
      if (exported.manifestPath) await cp(exported.manifestPath, path.join(evidence, 'owned-project-export.manifest.json'));
      results['exportedSource'] = exported;
      const query =
        mode === 'failure' ? "SELECT to_regclass('public.records')::text AS table_name" : 'SELECT count(*)::int AS n FROM records';
      const db = await guest(['sh', '-c', 'cd "$1" && node --import tsx server/agent-cli.ts db query "$2" --json', 'sh', cwd, query]);
      const database = JSON.parse(db.stdout);
      results['database'] = database;
      expect(database.ok).toBe(true);
      expect(database.data.rows).toEqual(mode === 'failure' ? [{ table_name: null }] : [{ n: 2 }]);
      results['outcome'] = 'passed';
    } catch (error) {
      failure = error;
      results['failure'] = String(error);
    } finally {
      try {
        await fileWrite(gateDir + '/release', nonce);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        if (runId) {
          const run = (await space()).runs.find((run) => run.runId === runId)!;
          if (['starting', 'running'].includes(run.state)) await requireCommand({ type: 'cancelRun', runId });
          const latest = (await space()).runs.find((run) => run.runId === runId)!;
          if (latest.appCleanupPending || latest.cleanupPending || latest.conversation?.cleanupPending)
            await requireCommand({ type: 'reconcileRunCleanup', runId });
          await cp(path.join(profile, 'app-control', runId), path.join(evidence, 'app-control', runId), { recursive: true });
        }
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        if ((await space()).managedApp?.state !== 'stopped') {
          await requireCommand({ type: 'stopApp' });
          await waitApp('stopped');
        }
        expect((await space()).managedApp?.cleanupConfirmed).toBe(true);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        if (ownedPort !== undefined && !beforePorts.some((port) => port.sandbox_port === ownedPort))
          expect((await ports()).filter((port) => port.sandbox_port === ownedPort)).toEqual([]);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      try {
        await app.close();
        results['appExited'] = electron.exitCode !== null || electron.signalCode !== null;
      } catch (error) {
        cleanupErrors.push(String(error));
      }
      results['retainedOwnedProject'] = cwd;
      results['cleanupErrors'] = cleanupErrors;
      await save();
    }
    if (cleanupErrors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Backend cancellation live verification/cleanup failed');
    if (failure) throw failure;
  });
