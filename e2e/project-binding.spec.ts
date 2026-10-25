import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { WorkbenchCommandSchema } from '../packages/protocol/src';
import { launchApp, target, workspaceSnapshot } from './helpers';

/*
 * OPS-1 B1：O05c（采集 → 移除引用 → 发送仍保留工程绑定）、O05d（重启后同一路径结果相同）、O05e（工程开关与“未选择工程”）。
 * 确定性 fixture：sbx 夹具与源码快照夹具（e2e/fixtures/source-snapshot-fixture.ts），不调用模型或真实 sandbox。
 */
// 与 p0-run-diff.spec.ts 相同的全局声明（TypeScript 要求同名全局声明类型一致）。
declare global {
  var __wslSourceFixture: {
    url: string;
    content: string;
    filePath: string;
    unavailable: boolean;
    holdSnapshots: boolean;
    holdPatches: boolean;
    patchFailure: boolean;
    patchIdentityMismatch: boolean;
    sourceRequests: unknown[];
    patchRequests: unknown[];
    sends: unknown[];
    pendingSnapshots: Map<string, unknown>;
    pendingPatches: unknown[];
    releaseSnapshots(): void;
    releasePatches(): void;
    finish(sessionId: string, state?: 'idle' | 'failed' | 'cancelled', cleanupPending?: boolean): void;
  };
}
const required = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
const sbxBin = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;
const sessionRegion = (page: Page) => page.getByRole('region', { name: 'Agent 会话内容', exact: true });
const projectGroup = (page: Page) => sessionRegion(page).getByRole('group', { name: '工程绑定', exact: true });
const projectButton = (page: Page, action: '开启' | '移除', name: string) =>
  projectGroup(page).getByRole('button', { name: `${action}工程：${name}`, exact: true });
/** 开启：显示「工程：{App 名}」与移除按钮，没有“未选择工程”与开启按钮。 */
async function expectProjectOn(page: Page, name: string) {
  await expect(projectButton(page, '移除', name)).toBeVisible();
  await expect(projectGroup(page)).toContainText(`工程：${name}`);
  await expect(projectGroup(page)).not.toContainText('未选择工程');
  await expect(projectButton(page, '开启', name)).toHaveCount(0);
}
/** 关闭：明确显示“未选择工程”；空间有 App 时提供一次点击的开启按钮。 */
async function expectProjectOff(page: Page, name: string) {
  await expect(projectGroup(page)).toContainText('未选择工程');
  await expect(projectButton(page, '开启', name)).toBeVisible();
  await expect(projectButton(page, '移除', name)).toHaveCount(0);
}

async function fixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Project Fixture</title><button style="margin:40px;padding:20px" data-testid="project-button">Project</button>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server missing port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function launch(userData: string, url: string) {
  const launched = await launchApp({ sbxBin, sourceSnapshotFixture: true, userData });
  await expect.poll(() => launched.page.evaluate(async () => (await window.studio.chat.getStatus()).available)).toBe(true);
  await launched.app.evaluate((_electron, value) => {
    __wslSourceFixture.url = value;
  }, url);
  return launched;
}
const commandOf = (page: Page) => async (data: Record<string, unknown>) => {
  const input = WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'taskflow-demo', ...data });
  return page.evaluate((command) => window.studio.workbench.command(command), input);
};
const owner = async (page: Page) =>
  required((await workspaceSnapshot(page)).workspaces.find((space) => space.workspaceId === 'taskflow-demo'));
const firstSession = async (page: Page) => required((await owner(page)).sessions[0]);
async function openSession(page: Page) {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await expect(sessionRegion(page)).toBeVisible();
}
async function sendFromComposer(page: Page, text: string) {
  const runs = (await owner(page)).runs.length;
  await sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true }).fill(text);
  await sessionRegion(page).getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await owner(page)).runs.length).toBe(runs + 1);
  const run = required((await owner(page)).runs.at(-1));
  const version = required((await firstSession(page)).taskVersions.find((item) => item.taskVersionId === run.taskVersionId));
  return { run, version };
}
async function finishRun(app: ElectronApplication, page: Page, sessionId: string, bound = true) {
  const runId = required((await owner(page)).runs.at(-1)).runId;
  await app.evaluate((_electron, id) => __wslSourceFixture.finish(id), sessionId);
  await expect.poll(async () => required((await owner(page)).runs.find((run) => run.runId === runId)).state).toBe('completed');
  if (bound)
    await expect
      .poll(async () => required((await owner(page)).runs.find((run) => run.runId === runId)).sourceChange?.state)
      .toBe('captured');
}
/** 项目写入登记生效：同一工程的另一会话在当前执行结束前不能开始（O05c）。 */
async function expectProjectWriterHeld(page: Page, otherSessionId: string, appId: string) {
  const command = commandOf(page);
  const before = (await owner(page)).runs.length;
  expect((await command({ type: 'saveTaskProject', sessionId: otherSessionId, appId })).ok).toBe(true);
  const confirmed = await command({
    type: 'confirmTask',
    sessionId: otherSessionId,
    goal: '同工程另一任务',
    targetRef: null,
    appId,
    captureId: null,
  });
  expect(confirmed.ok).toBe(true);
  const version = required(
    required((await owner(page)).sessions.find((session) => session.sessionId === otherSessionId)).taskVersions.at(-1),
  );
  const blocked = await command({ type: 'startRun', sessionId: otherSessionId, taskVersionId: version.taskVersionId });
  expect(blocked).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('同项目') } });
  expect((await owner(page)).runs.length).toBe(before);
}

test('O05c/O05d/O05e：工程开关独立于页面引用，移除引用与重启后发送仍绑定工程', async () => {
  test.skip(target !== 'build', 'deterministic Main/service injection uses the built Electron harness');
  const { server, url } = await fixtureServer();
  try {
    const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-project-binding-'));
    let { app, page, rendererErrors } = await launch(userData, url);
    let otherSessionId = '';
    try {
      const command = commandOf(page);
      await openSession(page);
      // 空间还没有 App：明确显示“未选择工程”，没有可开启的工程。
      await expect(projectGroup(page)).toContainText('未选择工程');
      await expect(projectGroup(page).getByRole('button')).toHaveCount(0);
      const other = await command({ type: 'createTab', kind: 'session', title: '同工程会话' });
      expect(other.ok).toBe(true);
      otherSessionId = required((await owner(page)).sessions.at(-1)).sessionId;
      expect((await command({ type: 'createApp' })).ok).toBe(true);
      expect((await command({ type: 'startApp' })).ok).toBe(true);
      const space = await owner(page);
      const app0 = required(space.app);
      const sessionId = required(space.sessions[0]).sessionId;
      const appPage = required(space.resources.find((resource) => resource.appProjectId));
      const guestCwd = required(space.managedApp).guestCwd;
      expect(guestCwd).toBe(`/home/agent/workspace/.wsl-apps/${app0.projectId}`);
      const bound = { appId: app0.appId, projectId: app0.projectId };
      expect(await firstSession(page)).toMatchObject({ taskProject: null, taskProjectDecided: false });

      // startApp 刚把 App 页面显示在唯一窗格中：在它仍可见时采集；首次采集受管 App 页面自动开启工程（S2）。
      await expect.poll(() => app.windows().some((window) => window.url().startsWith(url))).toBe(true);
      const browser = required(app.windows().find((window) => window.url().startsWith(url)));
      await expect(browser.getByTestId('project-button')).toBeVisible();
      expect((await command({ type: 'captureContext', sessionId, resourceId: appPage.resourceId, requestId: randomUUID() })).ok).toBe(true);
      await browser.getByTestId('project-button').click();
      await expect.poll(async () => (await firstSession(page)).captureRequest?.state).toBe('completed');
      expect(await firstSession(page)).toMatchObject({ taskProject: bound, taskProjectDecided: true });

      // 工程开关可移除、可再开启（O05e）。
      await openSession(page);
      await expectProjectOn(page, app0.name);
      await projectButton(page, '移除', app0.name).click();
      await expectProjectOff(page, app0.name);
      await expect.poll(async () => (await firstSession(page)).taskProject).toBeNull();
      await projectButton(page, '开启', app0.name).click();
      await expectProjectOn(page, app0.name);
      await expect.poll(async () => (await firstSession(page)).taskProject).toEqual(bound);

      // 采集完成即以该 App 页面为任务目标（OPS-1 B3，修正 F3a），输入框上方显示引用标签；移除引用后工程开关与采集证据都保留（O05c）。
      await expect.poll(async () => (await firstSession(page)).taskTargetRef?.resourceId).toBe(appPage.resourceId);
      const reference = sessionRegion(page).getByRole('group', { name: '页面引用', exact: true });
      await expect(reference).toContainText('Project · Project Fixture');
      await reference.getByRole('button', { name: '移除引用：Project · Project Fixture', exact: true }).click();
      await expect.poll(async () => (await firstSession(page)).taskTargetRef).toBeNull();
      await expect(reference).toHaveCount(0);
      const afterRemoval = await firstSession(page);
      expect(afterRemoval.taskProject).toEqual(bound);
      expect(afterRemoval.context).not.toBeNull();
      await expectProjectOn(page, app0.name);

      const { run, version } = await sendFromComposer(page, 'O05c：移除引用后只改工程');
      // 任务版本保留工程绑定（appTarget 含 guestCwd），没有页面证据。
      expect(version).toMatchObject({ targetRef: null, capture: null, captureBinding: null, appTarget: { ...app0, guestCwd } });
      // 源码基线在派发模型前保存；项目写入登记生效；结束后 diff 可读。
      await expect.poll(async () => required((await owner(page)).runs.at(-1)).sourceChange?.state).toBe('baseline');
      expect(await app.evaluate(() => __wslSourceFixture.sourceRequests.length)).toBe(1);
      await expectProjectWriterHeld(page, otherSessionId, app0.appId);
      await finishRun(app, page, sessionId);
      const patch = await page.evaluate((runId) => window.studio.workbench.runPatch('taskflow-demo', runId), run.runId);
      expect(patch.runId).toBe(run.runId);
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }

    // O05d：同一 userData 重启后工程选择仍在；服务确认的 App 状态下，同一路径（发送）得到同样的工程绑定、写入登记与 diff。
    ({ app, page, rendererErrors } = await launch(userData, url));
    try {
      const space = await owner(page);
      const app0 = required(space.app);
      const session = required(space.sessions[0]);
      expect(space.managedApp).toMatchObject({ state: 'stopped', cleanupConfirmed: true, error: null });
      expect(session).toMatchObject({ taskProject: { appId: app0.appId, projectId: app0.projectId }, taskProjectDecided: true });
      expect(required(session.taskVersions[0]).appTarget?.projectId).toBe(app0.projectId);
      await openSession(page);
      await expectProjectOn(page, app0.name);
      const { run, version } = await sendFromComposer(page, 'O05d：重启后再次发送');
      expect(version).toMatchObject({ targetRef: null, capture: null, appTarget: { appId: app0.appId, projectId: app0.projectId } });
      expect(version.appTarget?.guestCwd).toBe(required(space.managedApp).guestCwd);
      await expect.poll(async () => required((await owner(page)).runs.at(-1)).sourceChange?.state).toBe('baseline');
      await expectProjectWriterHeld(page, otherSessionId, app0.appId);
      await finishRun(app, page, session.sessionId);
      const patch = await page.evaluate((runId) => window.studio.workbench.runPatch('taskflow-demo', runId), run.runId);
      expect(patch.runId).toBe(run.runId);

      // 关闭工程开关后发送：显示“未选择工程”，任务版本没有工程绑定，也不从任务文字推断。
      await projectButton(page, '移除', app0.name).click();
      await expectProjectOff(page, app0.name);
      await expect.poll(async () => (await firstSession(page)).taskProject).toBeNull();
      const unbound = await sendFromComposer(page, `改 ${app0.name} 的按钮`);
      expect(unbound.version.appTarget).toBeNull();
      expect(required((await owner(page)).runs.at(-1)).sourceChange).toMatchObject({ state: 'unavailable' });
      // 结束这次执行再关闭窗口，不留下需要关闭流程取消的运行。
      await finishRun(app, page, session.sessionId, false);
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

// Test-only Main boundary injection: retain the genuine command handler for every
// successful save and audit confirmation/dispatch before they reach application code.
type ProjectSaveOutcome = 'success' | 'reject' | 'throw';
async function installProjectSaveGate(app: ElectronApplication, outcomes: ProjectSaveOutcome[]) {
  await app.evaluate(({ ipcMain }, planned) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
    type Gate = { calls: string[]; release: (() => void) | null };
    const host = globalThis as unknown as { __projectSaveGate: Gate };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get('workbench:command');
    const snapshot = handlers.get('workbench:get-snapshot');
    if (!original || !snapshot) throw new Error('workbench handlers unavailable');
    const gate: Gate = { calls: [], release: null };
    host.__projectSaveGate = gate;
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request?: Record<string, unknown>) => {
      const type = String(request?.['type']);
      if (['saveTaskProject', 'confirmTask', 'startRun'].includes(type)) gate.calls.push(type);
      if (type === 'saveTaskProject' && planned.length) {
        const outcome = planned.shift();
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        gate.release = null;
        if (outcome === 'throw') throw new Error('injected project save transport failure');
        if (outcome === 'reject')
          return { ok: false, snapshot: await snapshot(event), error: { code: 'conflict', message: 'injected project save rejection' } };
      }
      return original(event, request);
    });
  }, outcomes);
}
const projectSaveAudit = (app: ElectronApplication) =>
  app.evaluate(() => {
    const gate = (globalThis as unknown as { __projectSaveGate: { calls: string[]; release: unknown } }).__projectSaveGate;
    return { calls: gate.calls, held: gate.release !== null };
  });
async function releaseProjectSave(app: ElectronApplication) {
  await app.evaluate(() => {
    const gate = (globalThis as unknown as { __projectSaveGate: { release: (() => void) | null } }).__projectSaveGate;
    if (!gate.release) throw new Error('project save is not pending');
    gate.release();
  });
}
async function expectNoTaskDispatch(app: ElectronApplication, page: Page, draft: string) {
  expect((await projectSaveAudit(app)).calls.filter((type) => type === 'confirmTask' || type === 'startRun')).toEqual([]);
  expect((await firstSession(page)).taskVersions).toHaveLength(0);
  expect((await owner(page)).runs).toHaveLength(0);
  expect((await firstSession(page)).draft).toBe(draft);
  await expect(sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue(draft);
}
async function dismissProjectErrors(page: Page) {
  const close = page.locator('.toasts').getByRole('button');
  while (await close.count()) await close.first().click();
}
async function prepareProjectSend() {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-project-save-'));
  const { server, url } = await fixtureServer();
  const launched = await launch(userData, url);
  const command = commandOf(launched.page);
  expect((await command({ type: 'createApp' })).ok).toBe(true);
  expect((await command({ type: 'startApp' })).ok).toBe(true);
  const app0 = required((await owner(launched.page)).app);
  const session = await firstSession(launched.page);
  expect((await command({ type: 'saveTaskProject', sessionId: session.sessionId, appId: app0.appId })).ok).toBe(true);
  await openSession(launched.page);
  await expectProjectOn(launched.page, app0.name);
  return { ...launched, server, app0, sessionId: session.sessionId };
}

for (const outcome of ['reject', 'throw'] as const) {
  // Electron owns its Page; Playwright requires the fixture argument before testInfo.
  // eslint-disable-next-line no-empty-pattern
  test(`P1 工程保存 ${outcome}：阻止发送和确认、保留草稿，显式重选成功后恢复`, async ({}, testInfo) => {
    test.skip(target !== 'build', 'Main IPC fault injection requires built Electron');
    const { app, page, server, app0, sessionId } = await prepareProjectSend();
    try {
      const draft = `工程保存失败 ${outcome} 的草稿`;
      const composer = sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true });
      const send = sessionRegion(page).getByRole('button', { name: '发送', exact: true });
      await composer.fill(draft);
      await expect.poll(async () => (await firstSession(page)).draft).toBe(draft);
      await installProjectSaveGate(app, [outcome]);
      await projectButton(page, '移除', app0.name).click();
      await expect.poll(async () => (await projectSaveAudit(app)).held).toBe(true);
      await send.click();
      await expect(send).toBeDisabled();
      await expectNoTaskDispatch(app, page, draft);
      await releaseProjectSave(app);
      await expect(send).toBeEnabled();
      await expect(page.locator('.toasts')).toContainText(
        outcome === 'reject' ? 'injected project save rejection' : 'injected project save transport failure',
      );
      await expectNoTaskDispatch(app, page, draft);
      await expect(page.locator('.toasts')).toContainText('请重新选择工程并保存成功后再发送。');
      await page.screenshot({ path: testInfo.outputPath(`${outcome}-draft-preserved.png`) });
      await dismissProjectErrors(page);
      // The failed promise remains a failed choice after settlement. OPS-1 S2 (B3) removed the separate confirmation entry:
      // 「发送」 is the only way to confirm, and the task view offers no 「确认任务（生成新版本）」 that could bypass the check.
      await send.click();
      await expect(page.locator('.toasts')).toContainText('请重新选择工程并保存成功后再发送。');
      await expect(send).toBeEnabled();
      await expectNoTaskDispatch(app, page, draft);
      await dismissProjectErrors(page);
      await sessionRegion(page).getByRole('button', { name: '任务', exact: true }).click();
      await expect(sessionRegion(page).getByRole('button', { name: '确认任务（生成新版本）', exact: true })).toHaveCount(0);
      await sessionRegion(page).getByRole('button', { name: '对话', exact: true }).click();
      await projectButton(page, '移除', app0.name).click();
      await expectProjectOff(page, app0.name);
      const sent = await sendFromComposer(page, draft);
      expect(sent.version.appTarget).toBeNull();
      expect((await projectSaveAudit(app)).calls.filter((type) => type === 'confirmTask' || type === 'startRun')).toEqual([
        'confirmTask',
        'startRun',
      ]);
      await finishRun(app, page, sessionId, false);
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

for (const laterChoice of [false, true]) {
  test(`P1 延迟工程保存：${laterChoice ? '等待中后续切换失败不能沿用旧成功结果' : '成功后才按新选择发送'}`, async () => {
    test.skip(target !== 'build', 'Main IPC fault injection requires built Electron');
    const { app, page, server, app0, sessionId } = await prepareProjectSend();
    try {
      const draft = '延迟工程保存的草稿';
      const send = sessionRegion(page).getByRole('button', { name: '发送', exact: true });
      await sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true }).fill(draft);
      await expect.poll(async () => (await firstSession(page)).draft).toBe(draft);
      await installProjectSaveGate(app, laterChoice ? ['success', 'reject'] : ['success']);
      await projectButton(page, '移除', app0.name).click();
      await expect.poll(async () => (await projectSaveAudit(app)).held).toBe(true);
      await send.click();
      await expect(send).toBeDisabled();
      if (laterChoice) await projectButton(page, '移除', app0.name).click();
      await expectNoTaskDispatch(app, page, draft);
      await releaseProjectSave(app);
      if (laterChoice) {
        await expect.poll(async () => (await projectSaveAudit(app)).calls.filter((type) => type === 'saveTaskProject').length).toBe(2);
        await expect.poll(async () => (await projectSaveAudit(app)).held).toBe(true);
        await expectNoTaskDispatch(app, page, draft);
        await releaseProjectSave(app);
        await expect(send).toBeEnabled();
        await expectNoTaskDispatch(app, page, draft);
        await expect(page.locator('.toasts')).toContainText('injected project save rejection');
      } else {
        await expect.poll(async () => (await owner(page)).runs.length).toBe(1);
        expect(required((await firstSession(page)).taskVersions.at(-1)).appTarget).toBeNull();
        expect((await projectSaveAudit(app)).calls).toEqual(['saveTaskProject', 'confirmTask', 'startRun']);
        await expect(sessionRegion(page).getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('');
        await finishRun(app, page, sessionId, false);
      }
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}
