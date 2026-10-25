import { randomUUID } from 'node:crypto';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { WorkbenchCommandSchema, type TargetRef, type WorkbenchResult } from '../packages/protocol/src';
import { launchApp, target, workspaceSnapshot } from './helpers';

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
const region = (page: Page) => page.getByRole('region', { name: 'Agent 会话内容', exact: true });
const composer = (page: Page) => region(page).getByRole('textbox', { name: '会话消息', exact: true });
const send = (page: Page) => region(page).getByRole('button', { name: '发送', exact: true });
const targetSelect = (page: Page) => region(page).getByLabel('附加目标（文件 / 终端 / SSH）');
const removeReference = (page: Page) =>
  region(page)
    .getByRole('group', { name: '页面引用', exact: true })
    .getByRole('button', { name: /^移除引用：/ });
const owner = async (page: Page) =>
  required((await workspaceSnapshot(page)).workspaces.find((space) => space.workspaceId === 'taskflow-demo'));
const session = async (page: Page) => required((await owner(page)).sessions[0]);
const command = async (page: Page, data: Record<string, unknown>) =>
  page.evaluate(
    (input) => window.studio.workbench.command(input),
    WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'taskflow-demo', ...data }),
  );

type SaveType = 'saveTaskTarget' | 'saveTaskProject';
type Outcome = 'success' | 'reject' | 'throw';
type Step = { type: SaveType; outcome: Outcome; afterSuccess?: boolean };
type Gate = { calls: Record<string, unknown>[]; releases: Partial<Record<SaveType, () => void>> };
async function installGate(app: ElectronApplication, steps: Step[]) {
  await app.evaluate(({ ipcMain }, planned) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get('workbench:command');
    const snapshot = handlers.get('workbench:get-snapshot');
    if (!original || !snapshot) throw new Error('workbench handlers unavailable');
    const gate: Gate = { calls: [], releases: {} };
    (globalThis as unknown as { __targetSaveGate: Gate }).__targetSaveGate = gate;
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request?: Record<string, unknown>) => {
      const type = String(request?.['type']);
      if (['saveTaskTarget', 'saveTaskProject', 'confirmTask', 'startRun'].includes(type)) gate.calls.push({ ...request });
      const index = planned.findIndex((step) => step.type === type);
      if (index !== -1) {
        const step = planned.splice(index, 1)[0];
        if (!step) throw new Error('missing planned save outcome');
        const applied = step.afterSuccess ? ((await original(event, request)) as WorkbenchResult) : null;
        if (applied && !applied.ok) return applied;
        await new Promise<void>((resolve) => {
          gate.releases[step.type] = resolve;
        });
        delete gate.releases[step.type];
        if (step.outcome === 'throw') throw new Error('injected target save transport failure');
        if (step.outcome === 'reject')
          return { ok: false, snapshot: await snapshot(event), error: { code: 'conflict', message: `injected ${type} rejection` } };
        if (applied) return applied;
      }
      return original(event, request);
    });
  }, steps);
}
const audit = (app: ElectronApplication) =>
  app.evaluate(() => {
    const gate = (globalThis as unknown as { __targetSaveGate: Gate }).__targetSaveGate;
    return { calls: gate.calls, held: Object.keys(gate.releases) };
  });
const held = async (app: ElectronApplication, type: SaveType) => {
  await expect.poll(async () => (await audit(app)).held.includes(type)).toBe(true);
};
async function release(app: ElectronApplication, type: SaveType) {
  await app.evaluate((_electron, type) => {
    const resolve = (globalThis as unknown as { __targetSaveGate: Gate }).__targetSaveGate.releases[type];
    if (!resolve) throw new Error(`${type} is not held`);
    resolve();
  }, type);
}
async function noDispatch(app: ElectronApplication, page: Page, draft: string) {
  expect((await audit(app)).calls.filter((call) => ['confirmTask', 'startRun'].includes(String(call['type'])))).toEqual([]);
  expect((await session(page)).taskVersions).toHaveLength(0);
  expect((await owner(page)).runs).toHaveLength(0);
  expect((await session(page)).draft).toBe(draft);
  await expect(composer(page)).toHaveValue(draft);
}
async function dismissErrors(page: Page) {
  const buttons = page.locator('.toasts').getByRole('button');
  while (await buttons.count()) await buttons.first().click();
}
async function prepare() {
  const launched = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname, sourceSnapshotFixture: true });
  const { page } = launched;
  await expect.poll(() => page.evaluate(async () => (await window.studio.chat.getStatus()).available)).toBe(true);
  const space = await owner(page);
  const sessionId = required(space.sessions[0]).sessionId;
  const pageTarget = required(space.resources.find((resource) => resource.kind === 'web'));
  const terminal = required(space.resources.find((resource) => resource.kind === 'terminal'));
  const terminalTarget: TargetRef = { kind: 'terminal', resourceId: terminal.resourceId };
  expect(
    (await command(page, { type: 'saveTaskTarget', sessionId, targetRef: { kind: 'web', resourceId: pageTarget.resourceId } })).ok,
  ).toBe(true);
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await region(page)
    .getByRole('button', { name: /^任务设置/ })
    .click();
  await expect(removeReference(page)).toBeVisible();
  const draft = '目标保存故障的草稿';
  await composer(page).fill(draft);
  await expect.poll(async () => (await session(page)).draft).toBe(draft);
  return { ...launched, sessionId, terminalTarget, draft };
}
async function expectSent(app: ElectronApplication, page: Page, targetRef: TargetRef | null) {
  await expect.poll(async () => (await owner(page)).runs.length).toBe(1);
  expect((await session(page)).taskVersions).toHaveLength(1);
  expect(required((await session(page)).taskVersions[0]).targetRef).toEqual(targetRef);
  expect(
    (await audit(app)).calls.filter((call) => ['confirmTask', 'startRun'].includes(String(call['type']))).map((call) => call['type']),
  ).toEqual(['confirmTask', 'startRun']);
  await expect(composer(page)).toHaveValue('');
}

for (const outcome of ['reject', 'throw'] as const) {
  test(`P1 目标保存 ${outcome}：移除引用失败阻止发送、保留草稿，重选成功恢复`, async () => {
    test.skip(target !== 'build', 'Main IPC fault injection requires built Electron');
    const { app, page, terminalTarget, draft } = await prepare();
    try {
      await installGate(app, [{ type: 'saveTaskTarget', outcome }]);
      await removeReference(page).click();
      await held(app, 'saveTaskTarget');
      await send(page).click();
      await expect(send(page)).toBeDisabled();
      await noDispatch(app, page, draft);
      await release(app, 'saveTaskTarget');
      await expect(send(page)).toBeEnabled();
      await expect(page.locator('.toasts')).toContainText(
        outcome === 'throw' ? 'injected target save transport failure' : 'injected saveTaskTarget rejection',
      );
      await noDispatch(app, page, draft);
      await expect(removeReference(page)).toBeVisible();
      await expect(page.locator('.toasts')).toContainText('请重新选择任务目标并保存成功后再发送。');
      await dismissErrors(page);
      await send(page).click();
      await expect(page.locator('.toasts')).toContainText('请重新选择任务目标并保存成功后再发送。');
      await noDispatch(app, page, draft);
      await dismissErrors(page);
      await targetSelect(page).selectOption(terminalTarget.resourceId);
      await expect.poll(async () => (await session(page)).taskTargetRef).toEqual(terminalTarget);
      await send(page).click();
      await expectSent(app, page, terminalTarget);
    } finally {
      await app.close();
    }
  });
}

for (const laterChoice of [false, true]) {
  test(`P1 延迟目标保存：${laterChoice ? '后续选择失败不能沿用旧成功' : '成功后按新目标发送'}`, async () => {
    test.skip(target !== 'build', 'Main IPC fault injection requires built Electron');
    const { app, page, terminalTarget, draft } = await prepare();
    try {
      await installGate(app, [
        { type: 'saveTaskTarget', outcome: 'success' },
        ...(laterChoice ? [{ type: 'saveTaskTarget' as const, outcome: 'reject' as const }] : []),
      ]);
      await targetSelect(page).selectOption(terminalTarget.resourceId);
      await held(app, 'saveTaskTarget');
      await send(page).click();
      await expect(send(page)).toBeDisabled();
      if (laterChoice) await removeReference(page).click();
      await noDispatch(app, page, draft);
      await release(app, 'saveTaskTarget');
      if (laterChoice) {
        await expect.poll(async () => (await audit(app)).calls.filter((call) => call['type'] === 'saveTaskTarget').length).toBe(2);
        await held(app, 'saveTaskTarget');
        await noDispatch(app, page, draft);
        await release(app, 'saveTaskTarget');
        await expect(send(page)).toBeEnabled();
        await noDispatch(app, page, draft);
        await expect(page.locator('.toasts')).toContainText('请重新选择任务目标并保存成功后再发送。');
        await dismissErrors(page);
        await targetSelect(page).selectOption('');
        await expect.poll(async () => (await session(page)).taskTargetRef).toBeNull();
        await send(page).click();
        await expectSent(app, page, null);
      } else await expectSent(app, page, terminalTarget);
    } finally {
      await app.close();
    }
  });
}

for (const first of ['saveTaskProject', 'saveTaskTarget'] as const) {
  test(`P1 目标工程交错：等待 ${first} 时另一选择失败阻止派发`, async () => {
    test.skip(target !== 'build', 'Main IPC fault injection requires built Electron');
    const { app, page, terminalTarget, draft } = await prepare();
    try {
      expect((await command(page, { type: 'createApp' })).ok).toBe(true);
      const app0 = required((await owner(page)).app);
      const chooseProject = () =>
        region(page)
          .getByRole('button', { name: `开启工程：${app0.name}`, exact: true })
          .click();
      const chooseTarget = () => targetSelect(page).selectOption(terminalTarget.resourceId);
      const second: SaveType = first === 'saveTaskProject' ? 'saveTaskTarget' : 'saveTaskProject';
      await installGate(app, [
        { type: first, outcome: 'success' },
        { type: second, outcome: 'reject' },
      ]);
      await (first === 'saveTaskProject' ? chooseProject() : chooseTarget());
      await held(app, first);
      await send(page).click();
      await expect(send(page)).toBeDisabled();
      await (second === 'saveTaskProject' ? chooseProject() : chooseTarget());
      await noDispatch(app, page, draft);
      await release(app, first);
      await held(app, second);
      await noDispatch(app, page, draft);
      await release(app, second);
      await expect(send(page)).toBeEnabled();
      await noDispatch(app, page, draft);
      await expect(page.locator('.toasts')).toContainText(
        second === 'saveTaskTarget' ? '请重新选择任务目标并保存成功后再发送。' : '请重新选择工程并保存成功后再发送。',
      );
    } finally {
      await app.close();
    }
  });
}

test('P1 保存等待期间新增资源：发送冻结最新空间中的新目标', async () => {
  test.skip(target !== 'build', 'Main IPC fault injection requires built Electron');
  const { app, page, sessionId, draft } = await prepare();
  let expectedTarget: TargetRef | null = null;
  try {
    expect((await command(page, { type: 'createApp' })).ok).toBe(true);
    const before = await owner(page);
    const app0 = required(before.app);
    await installGate(app, [{ type: 'saveTaskProject', outcome: 'success', afterSuccess: true }]);
    await region(page)
      .getByRole('button', { name: `开启工程：${app0.name}`, exact: true })
      .click();
    await held(app, 'saveTaskProject');
    await expect.poll(async () => (await session(page)).taskProject?.appId).toBe(app0.appId);
    await expect(region(page).getByRole('button', { name: `移除工程：${app0.name}`, exact: true })).toBeVisible();
    await send(page).click();
    await expect(send(page)).toBeDisabled();
    await noDispatch(app, page, draft);

    // The pending send owns the render from before this resource exists. Main publishes
    // a genuine new resource and target after the project save succeeded, while only its reply is delayed.
    expect(
      (
        await command(page, {
          type: 'createTab',
          kind: 'terminal',
          title: '保存等待后新增终端',
          environmentId: 'sandbox',
          activate: false,
        })
      ).ok,
    ).toBe(true);
    const resource = required((await owner(page)).resources.find((item) => item.title === '保存等待后新增终端'));
    expect(before.resources.some((item) => item.resourceId === resource.resourceId)).toBe(false);
    const latestTarget: TargetRef = { kind: 'terminal', resourceId: resource.resourceId };
    expectedTarget = latestTarget;
    expect((await command(page, { type: 'saveTaskTarget', sessionId, targetRef: latestTarget })).ok).toBe(true);
    await expect.poll(async () => (await session(page)).taskTargetRef).toEqual(latestTarget);
    await noDispatch(app, page, draft);

    await release(app, 'saveTaskProject');
    await expect.poll(async () => (await audit(app)).calls.some((item) => item['type'] === 'confirmTask')).toBe(true);
    expect((await audit(app)).calls.find((item) => item['type'] === 'confirmTask')).toMatchObject({ targetRef: latestTarget });
    await expectSent(app, page, latestTarget);
  } finally {
    try {
      const current = await owner(page);
      await test.info().attach('delayed-target-diagnostics.json', {
        contentType: 'application/json',
        body: JSON.stringify({
          expectedTarget,
          audit: await audit(app),
          resources: current.resources.map(({ resourceId, kind, title }) => ({ resourceId, kind, title })),
          session: current.sessions.find((item) => item.sessionId === sessionId),
          runs: current.runs,
          toasts: await page.locator('.toasts').allTextContents(),
        }),
      });
    } finally {
      await app.close();
    }
  }
});
