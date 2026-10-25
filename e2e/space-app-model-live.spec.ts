import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { z } from 'zod';
import { launchApp, openBrowserMenu, setWindowSize, workspaceSnapshot, workshopNavigate } from './helpers';

const SourceSnapshot = z.object({
  source: z.string(),
  processes: z.array(z.object({ pid: z.number().int().positive(), startTime: z.string(), executable: z.string() })),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
// This observer only reads the explicitly bound project. The product invokes the model.
const readSourceScript = `import hashlib,json,os,sys
from pathlib import Path
root=Path(sys.argv[1])
files={}
excluded={'node_modules','dist','.data','data','.git','.vite'}
for directory,dirs,names in os.walk(root,followlinks=False):
    dirs[:]=sorted(name for name in dirs if name not in excluded and not name.startswith('.wsl-'))
    for name in sorted(names):
        if name.startswith('.wsl-'): continue
        file=Path(directory)/name
        if file.is_symlink(): raise RuntimeError('Unexpected source symlink')
        files[str(file.relative_to(root))]=hashlib.sha256(file.read_bytes()).hexdigest()
processes=[]
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit(): continue
    try:
        if proc.stat().st_uid != os.getuid(): continue
        try:
            cwd=(proc/'cwd').resolve(strict=True)
        except PermissionError: continue
        if cwd != root and root not in cwd.parents: continue
        environment=dict(item.split(b'=',1) for item in (proc/'environ').read_bytes().split(bytes([0])) if b'=' in item)
        if environment.get(b'WSL_PROJECT_ID') != sys.argv[2].encode(): continue
        stat=(proc/'stat').read_text().rsplit(')',1)[1].split()
        processes.append({'pid':int(proc.name),'startTime':stat[19],'executable':Path(os.readlink(proc/'exe')).name})
    except (FileNotFoundError,ProcessLookupError): continue
print(json.dumps({'source':(root/'src/App.tsx').read_text(),'files':files,'processes':processes},ensure_ascii=False))
`;

test('live: real App creation, native element capture and product model edit rebuild the same project', async () => {
  test.skip(process.env['WSL_APP_MODEL_LIVE'] !== '1', 'requires explicit real sandbox AND model authorization');
  test.setTimeout(900_000);
  const sandbox = process.env['WSL_SBX_NAME'];
  if (!sandbox) throw new Error('WSL_SBX_NAME must explicitly select the authorized live sandbox');
  const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
  const nonce = `WSL_APP_MODEL_${randomUUID().replaceAll('-', '')}`;
  // Each attempt has independent receipts; retries cannot overwrite an earlier failure.
  const evidenceRoot = path.resolve(process.env['WSL_APP_MODEL_EVIDENCE'] ?? 'test-results/space-app-model-live', nonce);
  const profile = path.join(evidenceRoot, 'profile');
  await mkdir(evidenceRoot, { recursive: true });
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    sandbox,
    nonce,
    profile,
    stage: 'launch',
    result: 'running',
  };
  const receipt = async (stage: string) => {
    evidence['stage'] = stage;
    await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
  };
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let owned: { workspaceId: string; projectId: string; appId: string } | undefined;
  let ownedRunId: string | undefined;
  let ownedTaskVersionId: string | undefined;
  let failure: unknown;
  const cleanupErrors: string[] = [];
  await receipt('launch');
  try {
    const launched = await launchApp({ live: true, userData: profile, sandbox });
    app = launched.app;
    page = launched.page;
    const mainPage = page;
    const application = app;
    await setWindowSize(application, 1440, 900);
    const state = async () => (await workspaceSnapshot(mainPage)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
    const waitApp = async (expected: string) => {
      await expect
        .poll(
          async () => {
            const current = (await state()).managedApp;
            if (current?.state === 'failed' && expected !== 'failed') throw new Error(`App ${expected} failed: ${current.error}`);
            return current?.state;
          },
          { timeout: 280000, intervals: [250, 500, 1000] },
        )
        .toBe(expected);
    };
    const sources = async (cwd: string) => {
      const result = await promisify(execFile)(binary, ['exec', sandbox, 'python3', '-c', readSourceScript, cwd, owned!.projectId], {
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return SourceSnapshot.parse(JSON.parse(result.stdout));
    };
    await workshopNavigate(mainPage, '空间');
    await mainPage.getByRole('button', { name: '新建 App', exact: true }).click();
    await mainPage.getByRole('button', { name: '创建标准应用', exact: true }).click();
    const editor = mainPage.getByRole('dialog', { name: '创建 App', exact: true });
    await editor.getByLabel('App 名称').fill(`真实模型验证 ${nonce}`);
    await editor.getByLabel('App 说明').fill('本次仅授权修改当前 App 的 src/App.tsx 标题');
    await editor.getByRole('button', { name: '保存 App' }).click();
    await expect(editor).not.toBeVisible();
    await mainPage.getByRole('button', { name: '管理 App', exact: true }).click();
    await expect.poll(async () => (await state()).app?.appId, { timeout: 15000 }).toBeTruthy();
    const registered = await state();
    owned = { workspaceId: registered.workspaceId, projectId: registered.app!.projectId, appId: registered.app!.appId };
    await waitApp('created');
    const created = await state();
    evidence['created'] = { app: created.app, managedApp: created.managedApp };
    await receipt('created');
    await mainPage.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitApp('running');
    const running = (await state()).managedApp!;
    evidence['firstRuntime'] = running;
    await expect.poll(() => application.windows().some((p) => p.url().startsWith(running.url!)), { timeout: 20000 }).toBe(true);
    const native = application.windows().find((p) => p.url().startsWith(running.url!))!;
    await expect(native.getByRole('heading', { name: '从这里开始构建', exact: true })).toBeVisible();
    await expect(native.getByTestId('app-instance-id')).toHaveText(running.appInstanceId!);
    await expect
      .poll(async () => (await state()).resources.find((r) => r.appProjectId === owned!.projectId)?.preview?.page.url)
      .toBe(native.url());
    const browser = (await state()).resources.find((r) => r.appProjectId === owned!.projectId)!;
    const originalPage = browser.preview!.page;
    const nativeIdentity = await application.evaluate(({ BrowserWindow }, id) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
        (child) => (child as Electron.WebContentsView).webContents?.id === id,
      ) as Electron.WebContentsView | undefined;
      return view ? { id: view.webContents.id, visible: view.getVisible(), url: view.webContents.getURL() } : null;
    }, originalPage.webContentsId);
    expect(nativeIdentity).toEqual({ id: originalPage.webContentsId, visible: true, url: native.url() });
    const before = await sources(running.guestCwd);
    expect(before.source.split('从这里开始构建')).toHaveLength(2);
    await writeFile(path.join(evidenceRoot, 'App.before.tsx'), before.source);
    evidence['sourceBefore'] = before.files;
    evidence['ownedAppProcessesBefore'] = before.processes;
    expect(before.processes.length).toBeGreaterThan(0);
    evidence['nativePageBefore'] = { resourceId: browser.resourceId, page: originalPage, nativeIdentity };
    await native.screenshot({ path: path.join(evidenceRoot, 'native-before.png') });
    await receipt('capture');
    const receiver = (await state()).sessions[0]!;
    const browserUi = mainPage
      .locator('.workspace-browser:visible')
      .filter({ has: mainPage.locator(`[id="address-${browser.resourceId}"]`) });
    await expect(browserUi).toHaveCount(1);
    await expect(browserUi.getByLabel('页面地址', { exact: true })).toHaveValue(native.url());
    // 接收者原生菜单（OPS-1 S1）选定接收会话；「选择元素」一步发起采集。
    await openBrowserMenu(application, mainPage, '接收会话', receiver.title, browserUi);
    await browserUi.getByRole('button', { name: '选择元素', exact: true }).click();
    await expect.poll(async () => (await state()).resources.find((r) => r.resourceId === browser.resourceId)?.preview?.picking).toBe(true);
    const point = await native.getByRole('heading', { name: '从这里开始构建', exact: true }).boundingBox();
    if (!point) throw new Error('Native heading has no layout box');
    await application.evaluate(
      ({ webContents }, input) => {
        const target = webContents.fromId(input.id);
        if (!target) throw new Error('Captured native page disappeared');
        target.sendInputEvent({ type: 'mouseMove', x: input.x, y: input.y });
        target.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 });
        target.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 });
      },
      { id: originalPage.webContentsId, x: Math.round(point.x + point.width / 2), y: Math.round(point.y + point.height / 2) },
    );
    const session = mainPage.getByRole('region', { name: 'Agent 会话内容' });
    // 采集完成后不再跳到「上下文」（OPS-1 S1）：等 Main 写入结果，再在「上下文」视图核对现场。
    await expect
      .poll(async () => (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)?.captureRequest?.state)
      .toBe('completed');
    await session.getByRole('button', { name: '上下文', exact: true }).click();
    await expect(session).toContainText('现场适用性：有效');
    const captured = (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!;
    expect(captured.contextTarget).toEqual({ kind: 'web', resourceId: browser.resourceId });
    expect(captured.context!.page).toEqual(originalPage);
    expect(captured.context!.element).toMatchObject({ tagName: 'h1', text: '从这里开始构建' });
    expect(captured.context!.element.selector).toContain('h1');
    expect(captured.context!.screenshot.viewport).toMatch(/^data:image\/png;base64,/);
    // 采集完成即以该页面为任务目标（OPS-1 B3）；范围与验收在「任务设置」，目标在底部输入框，「发送」= 确认 + 开始运行。
    expect(captured.taskTargetRef).toEqual({ kind: 'web', resourceId: browser.resourceId });
    const allowedFile = `${running.guestCwd}/src/App.tsx`;
    await session.getByRole('button', { name: /^任务设置/ }).click();
    await session.getByLabel('允许修改范围（每行一条）').fill(allowedFile);
    await session.getByLabel('验收条件（每行一条）').fill(`只有 src/App.tsx 的目标标题发生变化\n原生 App 页面重启后显示 ${nonce}`);
    await session
      .getByRole('textbox', { name: '会话消息', exact: true })
      .fill(
        `直接使用工具修改 Main 绑定的当前 App 工程。只在 src/App.tsx 中将所选 h1 的文字“从这里开始构建”替换为“${nonce}”。只做这一次字符串替换，其他文件和其他字节保持原样，不格式化，不安装依赖，不构建，不启动或停止进程，不修改其他工程。完成后读取该文件核对并简短报告。`,
      );
    await receipt('model-start');
    await session.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .poll(async () => (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!.taskVersions.length)
      .toBeGreaterThan(0);
    const confirmed = (await state()).sessions.find((s) => s.sessionId === receiver.sessionId)!.taskVersions.at(-1)!;
    expect(confirmed.appTarget).toMatchObject({ ...owned, guestCwd: running.guestCwd });
    expect(confirmed.allowedScopes).toEqual([allowedFile]);
    expect(confirmed.capture!.captureId).toBe(captured.context!.captureId);
    expect(confirmed.captureBinding).toMatchObject({ instanceId: browser.instanceId, generation: browser.generation });
    const { screenshot: _screenshot, ...captureIdentity } = confirmed.capture!;
    evidence['confirmed'] = { ...confirmed, capture: captureIdentity };
    ownedTaskVersionId = confirmed.taskVersionId;
    await expect
      .poll(
        async () => {
          const run = (await state()).runs.find((r) => r.taskVersionId === confirmed.taskVersionId);
          if (run) ownedRunId = run.runId;
          if (run?.state === 'failed' || run?.state === 'cancelled') {
            evidence['failedRun'] = run;
            throw new Error(`Product model run ${run.state}: ${run.error}`);
          }
          return run?.state;
        },
        { timeout: 300000, intervals: [500, 1000, 2000] },
      )
      .toBe('completed');
    const run = (await state()).runs.find((r) => r.runId === ownedRunId)!;
    evidence['modelRun'] = run;
    expect(run.executionBinding?.turnId).toBeTruthy();
    expect(run.conversation?.toolExecutions.length).toBeGreaterThan(0);
    expect(run.conversation?.cleanupPending).toBe(false);
    const toolCommands = run.conversation!.toolExecutions.map((tool) => tool.command).join('\n');
    expect(toolCommands).toContain(running.guestCwd);
    expect(toolCommands).toContain('src/App.tsx');
    expect(run.review).toBeNull();
    expect(run.validation.state).toBe('not_run');
    const after = await sources(running.guestCwd);
    await writeFile(path.join(evidenceRoot, 'App.after.tsx'), after.source);
    evidence['sourceAfter'] = after.files;
    expect(after.source).toBe(before.source.replace('从这里开始构建', nonce));
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
    expect(Object.keys(after.files).filter((file) => after.files[file] !== before.files[file])).toEqual(['src/App.tsx']);
    await receipt('model-source-verified');
    await mainPage.getByRole('button', { name: '停止应用', exact: true }).click();
    await waitApp('stopped');
    expect((await state()).managedApp!.cleanupConfirmed).toBe(true);
    evidence['ownedAppProcessesAfterStop'] = (await sources(running.guestCwd)).processes;
    expect(evidence['ownedAppProcessesAfterStop']).toEqual([]);
    await mainPage.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitApp('running');
    const restarted = (await state()).managedApp!;
    expect(restarted.projectId).toBe(owned.projectId);
    expect(restarted.appInstanceId).not.toBe(running.appInstanceId);
    await expect.poll(() => application.windows().some((p) => p.url().startsWith(restarted.url!)), { timeout: 20000 }).toBe(true);
    const reopened = application.windows().find((p) => p.url().startsWith(restarted.url!))!;
    await expect(reopened.getByRole('heading', { name: nonce, exact: true })).toBeVisible();
    await expect(reopened.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(reopened.getByRole('heading', { name: '应用服务', exact: true })).toBeVisible();
    await expect(reopened.getByTestId('app-instance-id')).toHaveText(restarted.appInstanceId!);
    const health = await reopened.evaluate(async () => await (await fetch('/api/health')).json());
    expect(health.identity.projectId).toBe(owned.projectId);
    expect(health.identity.workspaceId).toBe(owned.workspaceId);
    expect(health.identity.appInstanceId).toBe(restarted.appInstanceId);
    expect((await state()).resources.find((r) => r.appProjectId === owned!.projectId)!.resourceId).toBe(browser.resourceId);
    evidence['rebuilt'] = { runtime: restarted, health };
    await reopened.screenshot({ path: path.join(evidenceRoot, 'native-after.png') });
    await mainPage.screenshot({ path: path.join(evidenceRoot, 'renderer-after.png') });
    const windowPng = await application.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
    );
    await writeFile(path.join(evidenceRoot, 'native-window-after.png'), Buffer.from(windowPng, 'base64'));
    evidence['rendererErrors'] = launched.rendererErrors;
    expect(launched.rendererErrors).toEqual([]);
    evidence['result'] = 'passed';
    await receipt('native-rebuild-verified');
  } catch (error) {
    evidence['result'] = 'failed';
    evidence['error'] = error instanceof Error ? error.stack : String(error);
    failure = error;
    await receipt(String(evidence['stage']));
  } finally {
    // Only this fresh profile's bound run and app may be stopped; guest source and receipts remain.
    const cleanupOwnedResources = async () => {
      if (app && page && owned) {
        try {
          const owner = (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === owned!.workspaceId)!;
          if (owner.app?.appId !== owned.appId || owner.managedApp?.projectId !== owned.projectId)
            throw new Error('Cleanup App ownership changed');
          // A click may start the run before polling learns its ID. Its frozen task version is still owned.
          const candidates = owner.runs.filter(
            (r) => r.runId === ownedRunId || (ownedTaskVersionId && r.taskVersionId === ownedTaskVersionId),
          );
          if (candidates.length > 1) throw new Error('Cleanup run ownership is ambiguous');
          const run = candidates[0];
          try {
            if (run && ['starting', 'running', 'cancelling'].includes(run.state)) {
              const result = await page.evaluate(
                (target) => window.studio.workbench.command({ type: 'cancelRun', commandId: crypto.randomUUID(), ...target }),
                { workspaceId: owned.workspaceId, runId: run.runId },
              );
              if (!result.ok) throw new Error(`Cancel owned run failed: ${result.error.message}`);
              await expect
                .poll(
                  async () => {
                    const current = (await workspaceSnapshot(page!)).workspaces
                      .find((w) => w.workspaceId === owned!.workspaceId)!
                      .runs.find((r) => r.runId === run.runId);
                    evidence['runCleanup'] = current ?? null;
                    return Boolean(
                      current &&
                      ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state) &&
                      (current.conversation ? current.conversation.cleanupPending === false : current.executionBinding === null),
                    );
                  },
                  { timeout: 45000 },
                )
                .toBe(true);
            }
            const finalRun = run
              ? (await workspaceSnapshot(page)).workspaces
                  .find((w) => w.workspaceId === owned!.workspaceId)!
                  .runs.find((r) => r.runId === run.runId)
              : undefined;
            evidence['runCleanup'] = finalRun ?? null;
            if (run && !finalRun) throw new Error('Owned run disappeared before cleanup confirmation');
            if (finalRun) {
              expect(['completed', 'failed', 'cancelled', 'interrupted']).toContain(finalRun.state);
              if (finalRun.conversation) expect(finalRun.conversation.cleanupPending).toBe(false);
              else expect(finalRun.executionBinding).toBeNull();
            }
          } catch (error) {
            cleanupErrors.push(`Owned run cleanup: ${String(error)}`);
          }
          if (!owner.managedApp.cleanupConfirmed) {
            const stopped = await page.evaluate(
              (workspaceId) => window.studio.workbench.command({ type: 'stopApp', commandId: crypto.randomUUID(), workspaceId }),
              owned.workspaceId,
            );
            if (!stopped.ok) throw new Error(`Stop owned App failed: ${stopped.error.message}`);
            expect(stopped.snapshot.workspaces.find((w) => w.workspaceId === owned!.workspaceId)!.managedApp!.cleanupConfirmed).toBe(true);
            const cleaned = stopped.snapshot.workspaces.find((w) => w.workspaceId === owned!.workspaceId)!.managedApp!;
            evidence['cleanup'] = cleaned;
            const processCheck = await promisify(execFile)(
              binary,
              ['exec', sandbox, 'python3', '-c', readSourceScript, cleaned.guestCwd, owned.projectId],
              { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
            );
            evidence['ownedAppProcessesAfterCleanup'] = SourceSnapshot.parse(JSON.parse(processCheck.stdout)).processes;
            expect(evidence['ownedAppProcessesAfterCleanup']).toEqual([]);
          }
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
      if (app) {
        try {
          await app.close();
        } catch (error) {
          cleanupErrors.push(`Application close: ${String(error)}`);
        }
      }
    };
    await cleanupOwnedResources();
    evidence['cleanupErrors'] = cleanupErrors;
    evidence['endedAt'] = new Date().toISOString();
    if (cleanupErrors.length) evidence['result'] = 'failed';
    await receipt(String(evidence['stage']));
    console.log('SPACE_APP_MODEL_LIVE_EVIDENCE', evidenceRoot);
  }
  if (failure) throw failure;
  expect(cleanupErrors).toEqual([]);
});
