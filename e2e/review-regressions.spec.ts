import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorkbenchCommand, WorkbenchResult, WorkbenchSnapshot } from '../packages/protocol/src';
import {
  launchApp,
  openBrowserMenu,
  setWindowSize,
  workspaceSnapshot,
  previewClick,
  previewElementCenter,
  workshopNavigate,
} from './helpers';

type ReviewGate = {
  commands: WorkbenchCommand[];
  failCriteria: boolean;
  failStart: boolean;
  holdConfirm: boolean;
  holdNavigate: boolean;
  holdStart: boolean;
  releases: Array<() => void>;
};
type ReviewGlobal = typeof globalThis & {
  reviewGate: ReviewGate;
  screenshotGate: { armed: boolean; entered: number; release: (() => void) | null };
};
let app: ElectronApplication, page: Page;
test.beforeEach(async () => {
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
  await setWindowSize(app, 1440, 900);
  await app.evaluate(({ ipcMain }) => {
    const host = globalThis as ReviewGlobal;
    host.reviewGate = {
      commands: [],
      failCriteria: false,
      failStart: false,
      holdConfirm: false,
      holdNavigate: false,
      holdStart: false,
      releases: [],
    };
    type Handler = (event: Electron.IpcMainInvokeEvent, command?: WorkbenchCommand) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const command = handlers.get('workbench:command')!;
    const get = handlers.get('workbench:get-snapshot')!;
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request: WorkbenchCommand): Promise<WorkbenchResult> => {
      const gate = host.reviewGate;
      gate.commands.push(request);
      if (
        (gate.holdNavigate && request.type === 'browserAction' && request.action === 'navigate') ||
        (gate.holdConfirm && request.type === 'confirmTask')
      )
        await new Promise<void>((resolve) => {
          gate.releases.push(resolve);
        });
      if (
        (gate.failCriteria && request.type === 'saveTaskCriteria') ||
        (gate.failStart && request.type === 'startRun') ||
        (gate.holdConfirm && request.type === 'confirmTask')
      )
        return {
          ok: false,
          error: { code: 'execution_failed', message: 'review: injected persistence/executor failure' },
          snapshot: (await get(event)) as WorkbenchSnapshot,
        };
      const result = (await command(event, request)) as WorkbenchResult;
      if (gate.holdStart && request.type === 'startRun')
        await new Promise<void>((resolve) => {
          gate.releases.push(resolve);
        });
      return result;
    });
  });
});
test.afterEach(async () => {
  await app?.close();
});
const session = () => page.getByRole('region', { name: 'Agent 会话内容' });
async function openSession() {
  await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await session().getByRole('button', { name: '任务', exact: true }).click();
}
async function release() {
  await app.evaluate(() => {
    const gate = (globalThis as ReviewGlobal).reviewGate;
    for (const resolve of gate.releases.splice(0)) resolve();
  });
}

test('rejected address navigation preserves the typed URL and focus', async () => {
  const address = page.getByLabel('页面地址');
  await address.fill('file:///review-forbidden');
  await address.press('Enter');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /denied|允许|拒绝|导航|不支持/ })
      .first(),
  ).toBeVisible();
  await expect(address).toHaveValue('file:///review-forbidden');
  await expect(address).toBeFocused();
});

test('navigation deduplicates pending submits, honors IME, and retains newer edits after success', async () => {
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdNavigate = true;
  });
  const address = page.getByLabel('页面地址');
  await address.fill('wsl-demo://taskflow/members.html');
  await address.dispatchEvent('compositionstart');
  await address.press('Enter');
  expect(
    await app.evaluate(
      () => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'browserAction' && c.action === 'navigate').length,
    ),
  ).toBe(0);
  await address.dispatchEvent('compositionend');
  await address.press('Enter');
  await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.releases.length)).toBe(1);
  await address.press('Enter');
  await address.fill('wsl-demo://taskflow/task.html?id=1');
  try {
    expect(
      await app.evaluate(
        () => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'browserAction' && c.action === 'navigate').length,
      ),
    ).toBe(1);
  } finally {
    await release();
  }
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.page.url)
    .toContain('members.html');
  await expect(address).toHaveValue('wsl-demo://taskflow/task.html?id=1');
});

for (const action of ['confirm', 'send'] as const)
  test(`${action} freezes visible criteria despite autosave failure and keeps failed input`, async () => {
    await openSession();
    await app.evaluate(() => {
      const gate = (globalThis as ReviewGlobal).reviewGate;
      gate.failCriteria = true;
      gate.failStart = true;
    });
    await session().getByLabel('修改目标').fill('保留当前目标');
    await session().getByLabel('允许修改范围（每行一条）').fill('src/current.ts');
    await session().getByLabel('验收条件（每行一条）').fill('当前验收一\n当前验收二');
    if (action === 'confirm') await session().getByRole('button', { name: '确认任务（生成新版本）' }).click();
    else await session().getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions.length).toBe(1);
    const version = (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions[0]!;
    expect(version.acceptance).toEqual(['当前验收一', '当前验收二']);
    expect(version.allowedScopes).toEqual(['src/current.ts']);
    await expect(session().getByLabel('会话消息')).toHaveValue('保留当前目标');
    await expect(session().getByLabel('验收条件（每行一条）')).toHaveValue('当前验收一\n当前验收二');
  });

test('failed confirmation does not navigate away from the view chosen during the pending request', async () => {
  await openSession();
  await session().getByLabel('修改目标').fill('确认失败后保留');
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdConfirm = true;
  });
  await session().getByRole('button', { name: '确认任务（生成新版本）' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.releases.length)).toBe(1);
  await session().getByRole('button', { name: '对话', exact: true }).click();
  await release();
  await expect(session().getByRole('button', { name: '对话', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(session().getByLabel('会话消息')).toHaveValue('确认失败后保留');
  expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions).toHaveLength(0);
});

for (const destination of ['tab', 'route', 'space', 'session-view-keyboard'] as const)
  test(`late screenshot preserves its owner without returning from ${destination}`, async () => {
    if (destination === 'session-view-keyboard') {
      await page.getByRole('button', { name: '左右分屏', exact: true }).click();
      await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
    }
    const initial = (await workspaceSnapshot(page)).workspaces[0]!;
    await openBrowserMenu(page, '采集到会话');
    await page.getByLabel('关联会话').selectOption(initial.sessions[0]!.sessionId);
    await app.evaluate(({ BrowserWindow }) => {
      const host = globalThis as ReviewGlobal;
      host.screenshotGate = { armed: true, entered: 0, release: null };
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView;
      const capture = view.webContents.capturePage.bind(view.webContents);
      view.webContents.capturePage = async (...args) => {
        const image = await capture(...args);
        const gate = host.screenshotGate;
        if (gate.armed) {
          gate.armed = false;
          gate.entered++;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return image;
      };
    });
    await openBrowserMenu(page, '采集到会话');
    await page.getByRole('button', { name: '采集到关联会话' }).click();
    await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
    await previewClick(app, await previewElementCenter(app, '[data-testid="due-1"]'));
    await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).screenshotGate.entered)).toBe(1);
    if (destination === 'tab') await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
    else if (destination === 'route') await workshopNavigate(page, '任务');
    else if (destination === 'session-view-keyboard') {
      const paneFocusCount = await app.evaluate(
        () => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'focusPane').length,
      );
      // Keyboard tabbing reaches the visible sibling pane without firing its pointer-down focus handler.
      await session().getByRole('button', { name: '对话', exact: true }).focus();
      await session().getByRole('button', { name: '对话', exact: true }).press('Tab');
      await expect(session().getByRole('button', { name: '任务', exact: true })).toBeFocused();
      await session().getByRole('button', { name: '任务', exact: true }).press('Enter');
      expect(await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'focusPane').length)).toBe(
        paneFocusCount,
      );
      await expect(session().getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-pressed', 'true');
    } else {
      await page.getByRole('button', { name: '切换空间', exact: true }).click();
      await page.getByRole('dialog', { name: '切换空间' }).getByRole('button', { name: '新建空间', exact: true }).click();
      const create = page.getByRole('dialog', { name: '新建空间', exact: true });
      await create.getByLabel('名称').fill('Review 其它空间');
      await create.getByRole('button', { name: '保存', exact: true }).click();
    }
    await app.evaluate(() => (globalThis as ReviewGlobal).screenshotGate.release!());
    await expect
      .poll(
        async () =>
          (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === initial.workspaceId)!.sessions[0]!.captureRequest?.state,
      )
      .toBe('completed');
    expect(
      await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'locateSession').length),
    ).toBe(0);
    if (destination === 'route') await expect(page.getByRole('heading', { name: '任务历史' })).toBeVisible();
    else if (destination === 'space')
      await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('Review 其它空间');
    else
      await expect(
        session().getByRole('button', { name: destination === 'session-view-keyboard' ? '任务' : '对话', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
  });

test('cancel reaches Main and stops the owned run while the startRun response is pending', async () => {
  await openSession();
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdStart = true;
  });
  await session().getByLabel('会话消息').fill('[slow]');
  await session().getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.releases.length)).toBe(1);
  try {
    await session().getByRole('button', { name: '取消回复' }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs[0]!.state).toBe('cancelled');
    expect(await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.commands.some((c) => c.type === 'cancelRun'))).toBe(true);
  } finally {
    await release();
  }
  await expect(session().getByLabel('会话消息')).toHaveValue('[slow]');
});
