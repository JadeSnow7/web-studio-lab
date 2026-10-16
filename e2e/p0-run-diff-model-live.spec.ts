import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { z } from 'zod';
import {
  AppTargetSchema,
  WorkbenchSnapshotSchema,
  type AppSourceSnapshot,
  type ManagedApp,
  type WorkbenchRun,
} from '../packages/protocol/src';
import { SourceSnapshotReader } from '../apps/service/src/source-snapshot';
import { launchApp, openBrowserMenu, setWindowSize, target, workspaceSnapshot, workshopNavigate } from './helpers';

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Expected an owned D live record');
  return value;
};
const auditSchema = z
  .object({
    truncated: z.literal(false),
    sends: z
      .array(
        z
          .object({
            runId: z.uuid(),
            beforeDispatch: z.literal(true),
            error: z.null(),
            outboundHostDetails: z.literal(false),
            baseline: AppTargetSchema.extend({ runId: z.uuid(), baseTree: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
          })
          .strict(),
      )
      .max(10),
    sourceRequests: z.array(z.object({ callId: z.uuid(), target: AppTargetSchema }).strict()).max(10),
    appCalls: z.array(z.object({ runId: z.uuid(), tool: z.string().max(100) }).strict()).max(100),
  })
  .strict();
const hashes = (snapshot: AppSourceSnapshot) =>
  Object.fromEntries(
    snapshot.files.map((file) => [file.path, createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex')]),
  );
const appSource = (snapshot: AppSourceSnapshot) =>
  Buffer.from(required(snapshot.files.find((file) => file.path === 'src/App.tsx')).base64, 'base64').toString('utf8');
const appReceipt = (app: ManagedApp) => ({
  workspaceId: app.workspaceId,
  projectId: app.projectId,
  appInstanceId: app.appInstanceId,
  state: app.state,
  cleanupConfirmed: app.cleanupConfirmed,
  url: app.url,
});
const runReceipt = (run: WorkbenchRun) => ({
  runId: run.runId,
  taskVersionId: run.taskVersionId,
  state: run.state,
  executorState: run.executorState,
  cleanupPending: run.cleanupPending,
  sourceCleanupPending: run.sourceCleanupPending,
  sourceChange: run.sourceChange,
  validation: run.validation,
  review: run.review,
});
const cleanRun = (run: WorkbenchRun) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) &&
  !run.cleanupPending &&
  !run.sourceCleanupPending &&
  (run.executorState ? !run.executorState.cleanupPending : run.executionBinding === null);

async function verifyVisibleNativeApp(app: ElectronApplication, page: Page, runtime: ManagedApp, nonce: string, evidenceRoot: string) {
  const url = required(runtime.url);
  const view = () =>
    app.evaluate(({ BrowserWindow, WebContentsView }, origin) => {
      const found = BrowserWindow.getAllWindows()
        .flatMap((window) => window.contentView.children)
        .find((child) => child instanceof WebContentsView && child.webContents.getURL().startsWith(origin));
      if (!(found instanceof WebContentsView)) return null;
      return { id: found.webContents.id, visible: found.getVisible(), bounds: found.getBounds(), url: found.webContents.getURL() };
    }, url);
  const before = await view();
  await workshopNavigate(page, '空间');
  await expect
    .poll(
      async () => {
        const current = await view();
        return !!current?.visible && current.bounds.width > 0 && current.bounds.height > 0;
      },
      { timeout: 10000 },
    )
    .toBe(true);
  await expect.poll(() => app.windows().some((window) => window.url().startsWith(url)), { timeout: 20000 }).toBe(true);
  const native = required(app.windows().find((window) => window.url().startsWith(url)));
  await expect(native.getByTestId('health-refresh')).toHaveText(nonce);
  await expect(native.getByTestId('project-id')).toHaveText(runtime.projectId);
  await expect(native.getByTestId('app-instance-id')).toHaveText(required(runtime.appInstanceId));
  await expect(native.getByRole('heading', { name: '从这里开始构建', exact: true })).toBeVisible();
  await native.screenshot({ path: path.join(evidenceRoot, 'native-after.png') });
  return { before, after: required(await view()) };
}

async function closeOwnedElectron(app: ElectronApplication, cleanupErrors: string[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          app.process().kill('SIGKILL');
          reject(new Error('Only the owned Electron was stopped; guest cleanup is not implied'));
        }, 45000);
      }),
    ]);
  } catch {
    cleanupErrors.push('Electron shutdown failed or timed out; local exit is not guest cleanup');
  } finally {
    clearTimeout(timer);
  }
}

test('live D: product model changes only the health-refresh idle label; host diff and rebuilt native App agree', async () => {
  test.skip(
    process.env['WSL_P0_D_MODEL_LIVE'] !== '1' || process.env['WSL_P0_D_RECHECK_LIVE'] === '1',
    'requires separate explicit real sandbox AND model authorization',
  );
  test.setTimeout(900000);
  const sandbox = process.env['WSL_SBX_NAME'];
  if (!sandbox) throw new Error('WSL_SBX_NAME must explicitly select the authorized live sandbox');
  if (target !== 'build') throw new Error('D dispatch observation requires the built Electron bootstrap, not a packaged run');
  const binary = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
  const nonce = `WSL_P0_D_${randomUUID().replaceAll('-', '')}`;
  const evidenceRoot = path.resolve('docs/verification/2026-10-15-p0-video', nonce);
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'wsl-p0-d-model-private-'));
  const collector = await readFile(path.resolve('apps/service/src/app-helper.py'), 'utf8');
  const evidence: Record<string, unknown> = {
    nonce,
    sandbox,
    startedAt: new Date().toISOString(),
    result: 'running',
    userAcceptance: 'not-established',
  };
  const cleanupErrors: string[] = [];
  const record = async (stage: string) => {
    evidence['stage'] = stage;
    await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  };
  let application: ElectronApplication | undefined;
  let mainPage: Page | undefined;
  let rendererErrors: string[] | null = null;
  let owned: { workspaceId: string; projectId: string; appId: string } | undefined;
  let taskVersionId: string | undefined;
  let runId: string | undefined;
  let failure: unknown;
  try {
    // Only a passive dispatch observer is installed; service, sandbox, model and source responses are genuine.
    const launched = await launchApp({ live: true, sandbox, userData: profile, sourceDispatchAudit: true });
    application = launched.app;
    mainPage = launched.page;
    rendererErrors = launched.rendererErrors;
    const app = application;
    const page = mainPage;
    await setWindowSize(app, 1440, 900);
    await record('service-readiness');
    await expect.poll(() => page.evaluate(async () => (await window.studio.chat.getStatus()).available), { timeout: 60000 }).toBe(true);
    const status = await page.evaluate(() => window.studio.chat.getStatus());
    expect(status.sandbox).toBe(sandbox);
    evidence['serviceReady'] = { available: status.available, sandbox: status.sandbox, version: status.version };
    const state = async () =>
      required((await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo'));
    const waitApp = async (expected: string) => {
      await expect
        .poll(
          async () => {
            const current = (await state()).managedApp;
            if (current?.state === 'failed') throw new Error('Owned App lifecycle failed; inspect the private profile');
            return current?.state;
          },
          { timeout: 280000, intervals: [250, 500, 1000] },
        )
        .toBe(expected);
    };
    const sources = async () => {
      const identity = required(owned);
      const key = AppTargetSchema.parse({ workspaceId: identity.workspaceId, projectId: identity.projectId });
      // A bounded read-only collector; it receives only the owned guest identity, never host evidence.
      try {
        const result = await promisify(execFile)(
          binary,
          [
            'exec',
            sandbox,
            'python3',
            '-I',
            '-u',
            '-c',
            'import sys,io\nsys.stdin=io.StringIO(sys.argv[1])\n' + collector,
            JSON.stringify({ operation: 'source-snapshot', ...key }),
          ],
          { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
        );
        const reader = new SourceSnapshotReader();
        reader.accept(result.stdout);
        return reader.result(key);
      } catch (error) {
        if (error && typeof error === 'object' && 'killed' in error && error.killed)
          cleanupErrors.push('Read-only guest observer cleanup unknown after local transport termination');
        throw error;
      }
    };
    await record('create');
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '创建 App', exact: true });
    await editor.getByLabel('App 名称').fill(`D 真实 diff ${nonce}`);
    await editor.getByLabel('App 说明').fill('仅授权固定 App 的 health-refresh 空闲按钮文字替换；构建与重启由用户另行执行。');
    await editor.getByRole('button', { name: '保存 App' }).click();
    await expect.poll(async () => (await state()).app?.appId).toBeTruthy();
    const registered = await state();
    const bound = required(registered.app);
    owned = { workspaceId: registered.workspaceId, projectId: bound.projectId, appId: bound.appId };
    await waitApp('created');
    await expect(editor).not.toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    await waitApp('running');
    await page.getByRole('dialog', { name: '空间 App', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    const running = required((await state()).managedApp);
    evidence['firstRuntime'] = appReceipt(running);
    await expect.poll(() => app.windows().some((window) => window.url().startsWith(required(running.url))), { timeout: 20000 }).toBe(true);
    const native = required(app.windows().find((window) => window.url().startsWith(required(running.url))));
    await expect(native.getByTestId('health-refresh')).toHaveText('检查连接');
    await expect(native.getByTestId('app-instance-id')).toHaveText(required(running.appInstanceId));
    await expect
      .poll(async () => (await state()).resources.find((resource) => resource.appProjectId === owned?.projectId)?.preview?.page.url)
      .toBe(native.url());
    const browser = required((await state()).resources.find((resource) => resource.appProjectId === owned?.projectId));
    const nativeIdentity = required(browser.preview).page;
    const before = await sources();
    const beforeText = appSource(before);
    const old = "busy ? '检查中…' : '检查连接'";
    expect(beforeText.split(old)).toHaveLength(2);
    evidence['sourceBefore'] = hashes(before);
    await writeFile(path.join(evidenceRoot, 'App.before.tsx'), beforeText);
    await native.screenshot({ path: path.join(evidenceRoot, 'native-before.png') });
    await record('element-capture');
    const receiver = required((await state()).sessions[0]);
    const browserUi = page.locator('.workspace-browser:visible').filter({ has: page.locator(`[id="address-${browser.resourceId}"]`) });
    await openBrowserMenu(page, '采集到会话', browserUi);
    await browserUi.getByLabel('关联会话', { exact: true }).selectOption(receiver.sessionId);
    await browserUi.getByRole('button', { name: '采集到关联会话', exact: true }).click();
    await expect
      .poll(async () => (await state()).resources.find((resource) => resource.resourceId === browser.resourceId)?.preview?.picking)
      .toBe(true);
    const box = required(await native.getByTestId('health-refresh').boundingBox());
    await app.evaluate(
      ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents) throw new Error('Owned native App disappeared');
        contents.sendInputEvent({ type: 'mouseMove', x: input.x, y: input.y });
        contents.sendInputEvent({ type: 'mouseDown', x: input.x, y: input.y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x: input.x, y: input.y, button: 'left', clickCount: 1 });
      },
      { id: nativeIdentity.webContentsId, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
    );
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await expect(session).toContainText('现场适用性：有效');
    const captured = required((await state()).sessions.find((item) => item.sessionId === receiver.sessionId));
    const element = required(captured.context?.element);
    expect(element).toMatchObject({ tagName: 'button', text: '检查连接', testId: 'health-refresh' });
    const selected = native.locator(element.selector);
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute('data-testid', 'health-refresh');
    await session.getByRole('button', { name: '任务', exact: true }).click();
    await session.getByLabel('附加目标（明确选择）').selectOption(browser.resourceId);
    const allowedFile = `${running.guestCwd}/src/App.tsx`;
    await session
      .getByLabel('修改目标', { exact: true })
      .fill(
        `只修改 Main 绑定的当前 App 工程 src/App.tsx，将 data-testid="health-refresh" 按钮的空闲文字“检查连接”替换成“${nonce}”。只替换这一处字符串，忙碌文字“检查中…”及其余所有字节保持原样，不格式化、不修改其他文件。只用文件读取/修改工具，不安装依赖、不构建、不运行项目代码、不执行 Git 或 curl/wget 命令、不启动或停止应用服务进程、不调用 App 控制面工具。即使模板约定建议更新 manifest 或重启，本轮也禁止这些动作；用户将在任务结束后自行停止并启动同一项目。读回文件核对并简短报告，不宣称验证通过或用户接受。`,
      );
    await session.getByLabel('允许修改范围（每行一条）').fill(allowedFile);
    await session
      .getByLabel('验收条件（每行一条）')
      .fill(`只有 src/App.tsx 空闲按钮标签的一处字符串变化\n任务页保存实际 diff\n用户重启同一项目后原生按钮显示 ${nonce}`);
    await session.getByRole('button', { name: '确认任务（生成新版本）', exact: true }).click();
    const confirmed = required(
      required((await state()).sessions.find((item) => item.sessionId === receiver.sessionId)).taskVersions.at(-1),
    );
    taskVersionId = confirmed.taskVersionId;
    expect(confirmed.allowedScopes).toEqual([allowedFile]);
    expect(confirmed.appTarget).toMatchObject({ ...owned, guestCwd: running.guestCwd });
    await record('model');
    await session.getByRole('button', { name: '开始运行', exact: true }).click();
    await expect
      .poll(
        async () => {
          const run = (await state()).runs.find((item) => item.taskVersionId === taskVersionId);
          if (run) runId = run.runId;
          if (run && ['failed', 'cancelled', 'interrupted'].includes(run.state))
            throw new Error('Product model did not complete the authorized D task');
          return run?.state;
        },
        { timeout: 300000, intervals: [500, 1000, 2000] },
      )
      .toBe('completed');
    await expect
      .poll(
        async () => {
          const source = (await state()).runs.find((item) => item.runId === runId)?.sourceChange;
          if (source?.state === 'unavailable') throw new Error('Product source evidence unavailable');
          return source?.state;
        },
        { timeout: 150000 },
      )
      .toBe('captured');
    const run = required((await state()).runs.find((item) => item.runId === runId));
    expect(cleanRun(run)).toBe(true);
    expect(run.sourceCleanupPending).toBe(false);
    expect(run.conversation?.toolExecutions.length).toBeGreaterThan(0);
    expect(run.validation.state).toBe('not_run');
    expect(run.review).toBeNull();
    const commands = required(run.conversation)
      .toolExecutions.map((tool) => tool.command)
      .join('\n');
    expect(commands).toContain('src/App.tsx');
    expect(commands).not.toMatch(/\b(?:npm|pnpm|yarn|npx)\b|app[_ .-](?:restart|start|stop|data[_ .-](?:reset|seed))/i);
    const audit = auditSchema.parse(await app.evaluate(() => __wslSourceDispatchAudit));
    expect(audit.sends).toHaveLength(1);
    expect(audit.sends[0]?.baseline).toMatchObject({ runId: run.runId, workspaceId: owned.workspaceId, projectId: owned.projectId });
    expect(audit.sourceRequests).toHaveLength(2);
    expect(audit.sourceRequests.every((request) => request.target.projectId === owned?.projectId)).toBe(true);
    expect(audit.appCalls).toEqual([]);
    const change = run.sourceChange;
    if (change?.state !== 'captured') throw new Error('Captured product source evidence missing');
    expect(change.baseTree).toBe(audit.sends[0]?.baseline.baseTree);
    expect(change.files.map((file) => file.path)).toEqual(['src/App.tsx']);
    expect(change.truncated).toBe(false);
    const after = await sources();
    const afterText = appSource(after);
    expect(afterText).toBe(beforeText.replace(old, `busy ? '检查中…' : '${nonce}'`));
    expect(Object.keys(hashes(after)).sort()).toEqual(Object.keys(hashes(before)).sort());
    expect(Object.keys(hashes(after)).filter((file) => hashes(after)[file] !== hashes(before)[file])).toEqual(['src/App.tsx']);
    const patch = await page.evaluate((id) => window.studio.workbench.runPatch('taskflow-demo', id), run.runId);
    expect(patch.patch).toContain(old);
    expect(patch.patch).toContain(nonce);
    expect(createHash('sha256').update(patch.patch).digest('hex')).toBe(change.patchSha256);
    expect(patch.patchSha256).toBe(change.patchSha256);
    expect(await readFile(path.join(profile, 'runs', run.runId, 'source.patch'), 'utf8')).toBe(patch.patch);
    expect(JSON.parse(await readFile(path.join(profile, 'runs', run.runId, 'baseline.json'), 'utf8'))).toEqual(audit.sends[0]?.baseline);
    evidence['dispatchAudit'] = audit;
    evidence['sourceAfter'] = hashes(after);
    evidence['modelRun'] = runReceipt(run);
    await writeFile(path.join(evidenceRoot, 'App.after.tsx'), afterText);
    await writeFile(path.join(evidenceRoot, 'source.patch'), patch.patch);
    await workshopNavigate(page, '任务');
    await page.getByRole('navigation', { name: '任务与运行记录' }).locator(`button[title="${run.runId}"]`).click();
    await page.getByRole('navigation', { name: '运行视图' }).getByRole('button', { name: 'diff', exact: true }).click();
    const details = page.getByRole('region', { name: '运行详情', exact: true });
    await expect(details.getByLabel('源码 diff', { exact: true })).toContainText(nonce);
    await expect(details).toContainText('不代表独立检查通过或用户接受');
    await page.screenshot({ path: path.join(evidenceRoot, 'task-diff.png') });
    expect(appReceipt(required((await state()).managedApp))).toEqual(appReceipt(running));
    await record('diff-verified');
    const stopped = await page.evaluate(
      (workspaceId) => window.studio.workbench.command({ type: 'stopApp', commandId: crypto.randomUUID(), workspaceId }),
      owned.workspaceId,
    );
    expect(stopped.ok).toBe(true);
    await waitApp('stopped');
    expect((await state()).managedApp?.cleanupConfirmed).toBe(true);
    const started = await page.evaluate(
      (workspaceId) => window.studio.workbench.command({ type: 'startApp', commandId: crypto.randomUUID(), workspaceId }),
      owned.workspaceId,
    );
    expect(started.ok).toBe(true);
    await waitApp('running');
    const rebuilt = required((await state()).managedApp);
    expect(rebuilt.projectId).toBe(owned.projectId);
    expect(rebuilt.appInstanceId).not.toBe(running.appInstanceId);
    evidence['nativeView'] = await verifyVisibleNativeApp(app, page, rebuilt, nonce, evidenceRoot);
    evidence['rebuilt'] = appReceipt(rebuilt);
    expect(launched.rendererErrors).toEqual([]);
    evidence['result'] = 'passed';
    await record('native-rebuild-verified');
  } catch (error) {
    failure = error;
    evidence['result'] = 'failed';
    evidence['failureKind'] = error instanceof Error ? error.name : 'unknown';
    evidence['failedStage'] = evidence['stage'];
  } finally {
    if (application) {
      try {
        const audit = auditSchema.parse(await application.evaluate(() => __wslSourceDispatchAudit));
        evidence['dispatchAudit'] = audit;
        evidence['modelDispatches'] = audit.sends.length;
      } catch {
        evidence['dispatchAuditUnavailable'] = true;
      }
    }
    if (mainPage && owned) {
      const page = mainPage;
      const identity = owned;
      try {
        const owner = required(
          (await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === identity.workspaceId),
        );
        expect(owner.app?.appId, 'Owned App identity changed').toBe(identity.appId);
        expect(owner.managedApp?.projectId, 'Owned project identity changed').toBe(identity.projectId);
        const candidates = owner.runs.filter((run) => run.runId === runId || (taskVersionId && run.taskVersionId === taskVersionId));
        expect(candidates.length, 'Owned task execution is ambiguous').toBeLessThanOrEqual(1);
        const run = candidates[0];
        if (run && !cleanRun(run)) {
          await page.evaluate((input) => window.studio.workbench.command({ type: 'cancelRun', commandId: crypto.randomUUID(), ...input }), {
            workspaceId: identity.workspaceId,
            runId: run.runId,
          });
          await expect
            .poll(
              async () => {
                const current = required(
                  (await workspaceSnapshot(page)).workspaces
                    .find((workspace) => workspace.workspaceId === identity.workspaceId)
                    ?.runs.find((item) => item.runId === run.runId),
                );
                evidence['runCleanup'] = runReceipt(current);
                return cleanRun(current);
              },
              { timeout: 45000 },
            )
            .toBe(true);
        } else if (run) evidence['runCleanup'] = runReceipt(run);
      } catch {
        cleanupErrors.push('Owned model/source cleanup unconfirmed; inspect private runtime');
      }
      try {
        const owner = required(
          (await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === identity.workspaceId),
        );
        expect(owner.app?.appId, 'Owned App identity changed before stop').toBe(identity.appId);
        expect(owner.managedApp?.projectId, 'Owned project identity changed before stop').toBe(identity.projectId);
        const result = await page.evaluate(
          (input) => window.studio.workbench.command({ type: 'stopApp', commandId: crypto.randomUUID(), ...input }),
          { workspaceId: identity.workspaceId, expectedRevision: owner.revision },
        );
        expect(result.ok).toBe(true);
        const stopped = required(
          result.snapshot.workspaces.find((workspace) => workspace.workspaceId === identity.workspaceId)?.managedApp,
        );
        expect(stopped.cleanupConfirmed).toBe(true);
        evidence['appCleanup'] = appReceipt(stopped);
      } catch {
        cleanupErrors.push('Owned App cleanup unconfirmed; inspect private runtime');
      }
    }
    if (application) await closeOwnedElectron(application, cleanupErrors);
    evidence['cleanupErrors'] = cleanupErrors;
    evidence['rendererErrors'] = rendererErrors;
    evidence['endedAt'] = new Date().toISOString();
    if (cleanupErrors.length || rendererErrors?.length) evidence['result'] = 'failed';
    await record('cleanup');
    console.log('P0_D_MODEL_LIVE_EVIDENCE', evidenceRoot, 'PRIVATE_PROFILE', profile);
  }
  if (failure) throw failure;
  expect(cleanupErrors).toEqual([]);
  expect(rendererErrors).toEqual([]);
});

test('live D: recover native evidence for the existing completed run without model dispatch', async () => {
  test.skip(process.env['WSL_P0_D_RECHECK_LIVE'] !== '1', 'requires explicit sandbox-only evidence recovery authorization');
  test.setTimeout(600000);
  if (process.env['WSL_P0_D_MODEL_LIVE'] === '1' || target !== 'build')
    throw new Error('Recovery must not enable a model run or packaged target');
  const sandbox = z.string().min(1).parse(process.env['WSL_SBX_NAME']);
  const profile = z.string().min(1).parse(process.env['WSL_P0_D_RECHECK_PROFILE']);
  const nonce = z
    .string()
    .regex(/^WSL_P0_D_[a-f0-9]{32}$/)
    .parse(process.env['WSL_P0_D_RECHECK_NONCE']);
  expect(path.isAbsolute(profile)).toBe(true);
  expect(path.basename(profile)).toMatch(/^wsl-p0-d-model-private-/);
  const priorRoot = path.resolve('docs/verification/2026-10-15-p0-video', nonce);
  const prior = z
    .object({
      nonce: z.literal(nonce),
      sandbox: z.literal(sandbox),
      result: z.literal('failed'),
      modelDispatches: z.literal(1),
      modelRun: z.object({ runId: z.uuid(), state: z.literal('completed') }),
      appCleanup: AppTargetSchema.extend({
        appInstanceId: z.uuid(),
        state: z.literal('stopped'),
        cleanupConfirmed: z.literal(true),
        url: z.null(),
      }),
    })
    .parse(JSON.parse(await readFile(path.join(priorRoot, 'evidence.json'), 'utf8')));
  const persisted = z
    .object({ snapshot: WorkbenchSnapshotSchema })
    .parse(JSON.parse(await readFile(path.join(profile, 'workbench.json'), 'utf8'))).snapshot;
  const before = required(persisted.workspaces.find((workspace) => workspace.workspaceId === prior.appCleanup.workspaceId));
  const owned = required(before.app);
  expect(owned.projectId).toBe(prior.appCleanup.projectId);
  expect(owned.name).toContain(nonce);
  expect(persisted.workspaces.flatMap((workspace) => (workspace.app ? [workspace.app.projectId] : []))).toEqual([owned.projectId]);
  expect(persisted.workspaces.flatMap((workspace) => workspace.runs).every(cleanRun)).toBe(true);
  const originalRun = required(before.runs.find((run) => run.runId === prior.modelRun.runId));
  const change = originalRun.sourceChange;
  if (change?.state !== 'captured') throw new Error('Existing captured source evidence is required');
  const originalPatch = await readFile(path.join(priorRoot, 'source.patch'), 'utf8');
  expect(createHash('sha256').update(originalPatch).digest('hex')).toBe(change.patchSha256);
  const evidenceRoot = await mkdtemp(path.join(priorRoot, 'native-recheck-'));
  const evidence: Record<string, unknown> = {
    nonce,
    sandbox,
    kind: 'existing-run-native-recovery',
    originalResult: prior.result,
    originalModelRun: runReceipt(originalRun),
    startedAt: new Date().toISOString(),
    result: 'running',
    userAcceptance: 'not-established',
  };
  const cleanupErrors: string[] = [];
  let application: ElectronApplication | undefined;
  let mainPage: Page | undefined;
  let rendererErrors: string[] | null = null;
  let failure: unknown;
  try {
    const launched = await launchApp({ live: true, sandbox, userData: profile, sourceDispatchAudit: true });
    application = launched.app;
    mainPage = launched.page;
    rendererErrors = launched.rendererErrors;
    const app = application;
    const page = mainPage;
    await setWindowSize(app, 1440, 900);
    await expect.poll(() => page.evaluate(async () => (await window.studio.chat.getStatus()).available), { timeout: 60000 }).toBe(true);
    expect((await page.evaluate(() => window.studio.chat.getStatus())).sandbox).toBe(sandbox);
    const state = async () =>
      required((await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === owned.workspaceId));
    await expect
      .poll(async () => (await state()).managedApp, { timeout: 60000 })
      .toMatchObject({ projectId: owned.projectId, cleanupConfirmed: true });
    const restored = await state();
    expect(restored.app?.appId).toBe(owned.appId);
    expect(restored.runs.map(runReceipt)).toEqual(before.runs.map(runReceipt));
    const patch = await page.evaluate((key) => window.studio.workbench.runPatch(key.workspaceId, key.runId), {
      workspaceId: owned.workspaceId,
      runId: originalRun.runId,
    });
    expect(patch.patchSha256).toBe(change.patchSha256);
    expect(patch.patch).toBe(originalPatch);
    await workshopNavigate(page, '任务');
    await page.getByRole('navigation', { name: '任务与运行记录' }).locator(`button[title="${originalRun.runId}"]`).click();
    await page.getByRole('navigation', { name: '运行视图' }).getByRole('button', { name: 'diff', exact: true }).click();
    const details = page.getByRole('region', { name: '运行详情', exact: true });
    await expect(details.getByLabel('源码 diff', { exact: true })).toContainText(nonce);
    await expect(details).toContainText('不代表独立检查通过或用户接受');
    await page.screenshot({ path: path.join(evidenceRoot, 'task-diff-restored.png') });
    const current = await state();
    const started = await page.evaluate(
      (input) => window.studio.workbench.command({ type: 'startApp', commandId: crypto.randomUUID(), ...input }),
      { workspaceId: owned.workspaceId, expectedRevision: current.revision },
    );
    expect(started.ok).toBe(true);
    const runtime = required((await state()).managedApp);
    expect(runtime.state).toBe('running');
    expect(runtime.projectId).toBe(owned.projectId);
    expect(runtime.appInstanceId).not.toBe(prior.appCleanup.appInstanceId);
    evidence['nativeView'] = await verifyVisibleNativeApp(app, page, runtime, nonce, evidenceRoot);
    evidence['rebuilt'] = appReceipt(runtime);
    expect((await state()).runs.map(runReceipt)).toEqual(before.runs.map(runReceipt));
    expect(launched.rendererErrors).toEqual([]);
    evidence['result'] = 'passed';
  } catch (error) {
    failure = error;
    evidence['result'] = 'failed';
    evidence['failureKind'] = error instanceof Error ? error.name : 'unknown';
  } finally {
    if (application) {
      try {
        const audit = auditSchema.parse(await application.evaluate(() => __wslSourceDispatchAudit));
        evidence['dispatchAudit'] = audit;
        evidence['modelDispatches'] = audit.sends.length;
        expect(audit.sends).toEqual([]);
        expect(audit.sourceRequests).toEqual([]);
        expect(audit.appCalls).toEqual([]);
      } catch {
        cleanupErrors.push('Recovery dispatch audit unavailable or unexpected model/source activity');
      }
    }
    if (mainPage) {
      try {
        const page = mainPage;
        const owner = required((await workspaceSnapshot(page)).workspaces.find((workspace) => workspace.workspaceId === owned.workspaceId));
        expect(owner.app?.appId).toBe(owned.appId);
        expect(owner.managedApp?.projectId).toBe(owned.projectId);
        expect(owner.runs.map(runReceipt)).toEqual(before.runs.map(runReceipt));
        const stopped = await page.evaluate(
          (input) => window.studio.workbench.command({ type: 'stopApp', commandId: crypto.randomUUID(), ...input }),
          { workspaceId: owned.workspaceId, expectedRevision: owner.revision },
        );
        expect(stopped.ok).toBe(true);
        const receipt = required(stopped.snapshot.workspaces.find((workspace) => workspace.workspaceId === owned.workspaceId)?.managedApp);
        expect(receipt.projectId).toBe(owned.projectId);
        expect(receipt.cleanupConfirmed).toBe(true);
        evidence['appCleanup'] = appReceipt(receipt);
        evidence['runCleanup'] = runReceipt(required(owner.runs.find((run) => run.runId === originalRun.runId)));
      } catch {
        cleanupErrors.push('Recovery owned App cleanup or unchanged run evidence unconfirmed');
      }
    }
    if (application) await closeOwnedElectron(application, cleanupErrors);
    evidence['rendererErrors'] = rendererErrors;
    evidence['cleanupErrors'] = cleanupErrors;
    evidence['endedAt'] = new Date().toISOString();
    if (cleanupErrors.length || rendererErrors?.length) evidence['result'] = 'failed';
    await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('P0_D_NATIVE_RECOVERY_EVIDENCE', evidenceRoot, 'PRIVATE_PROFILE', profile);
  }
  if (failure) throw failure;
  expect(cleanupErrors).toEqual([]);
  expect(rendererErrors).toEqual([]);
});
