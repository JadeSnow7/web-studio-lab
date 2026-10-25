import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  browserState,
  launchApp,
  openNewTabForm,
  paneMenu,
  pickNativeMenu,
  setWindowSize,
  tabMenu,
  windowShots,
  workspaceSnapshot,
} from './helpers';

/*
 * OPS-1 B3：S1 一步点选（O01–O04b）与 S2 单一发送路径（O05–O05e）。确定性 fixture：sbx 夹具（不调用模型、不启动真实 sandbox），
 * 演示网页 wsl-demo://taskflow。网页里的点击经 Main 对可见原生网页的 sendInputEvent 发出，与用户点击同一条输入路径。
 * 步数按“用户的一次点击或一次按键组合”计，不含输入文字（SPEC §5）。
 */

const sbxBin = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;
const DEMO = 'wsl-demo://taskflow/index.html';
const ELEMENT = '[data-testid="new-task"]';
const CHIP = '新建任务 · 任务 · TaskFlow 演示';
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};

const browserRoot = (page: Page) => page.locator('.workspace-browser:visible');
const selectButton = (page: Page) => browserRoot(page).getByRole('button', { name: '选择元素', exact: true });
const pickingButton = (page: Page) => browserRoot(page).getByRole('button', { name: '选择中 · Esc 取消', exact: true });
const receiverButton = (page: Page) => browserRoot(page).getByRole('button', { name: /^接收会话：/ });
const browserSlot = (page: Page) => browserRoot(page).locator('.status-slot .status-item');
const sessionRegion = (page: Page, title?: string) => {
  const regions = page.getByRole('region', { name: 'Agent 会话内容', exact: true });
  return title ? regions.filter({ has: page.getByRole('heading', { name: title, exact: true }) }) : regions;
};
const composer = (region: Locator) => region.getByRole('textbox', { name: '会话消息', exact: true });
const tabButton = (page: Page, title: string) =>
  page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: title, exact: true });

async function active(page: Page) {
  const snapshot = await workspaceSnapshot(page);
  return required(snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId));
}
async function sessionNamed(page: Page, title: string) {
  return required((await active(page)).sessions.find((s) => s.title === title));
}
const paneTabs = async (page: Page) => {
  const w = await active(page);
  const leaves = (layout: typeof w.layout): Array<string | null> =>
    layout.kind === 'pane' ? [layout.tabId] : [...leaves(layout.first), ...leaves(layout.second)];
  return leaves(w.layout).map((tabId) => (tabId ? (w.tabs.find((t) => t.tabId === tabId)?.title ?? '?') : null));
};

/** 在可见原生网页上点击元素中心（真实输入事件）。 */
async function clickInPage(app: ElectronApplication, selector: string) {
  await app.evaluate(async ({ BrowserWindow }, sel) => {
    const views = BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[];
    const view = views.find((candidate) => candidate.webContents && candidate.getVisible());
    if (!view) throw new Error('没有可见的原生网页');
    const wc = view.webContents;
    const p = (await wc.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    )) as { x: number; y: number };
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    await new Promise((resolve) => setTimeout(resolve, 120));
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }, selector);
}
/** 焦点在原生网页时按 Esc（真实键盘输入事件，经 before-input-event 到达 Main）。 */
async function escapeInPage(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[];
    const view = views.find((candidate) => candidate.webContents && candidate.getVisible());
    if (!view) throw new Error('没有可见的原生网页');
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
}
/** 原生网页仍然可见（Main 中真实的 WebContentsView 可见性，不只看 data-native）。 */
const nativeVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    (BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[]).some(
      (view) => view.webContents && view.getVisible(),
    ),
  );
/** Main 中获得键盘焦点的是工作台页面（R9：采集后焦点已从原生网页交回）。 */
const workbenchFocused = (app: ElectronApplication) =>
  app.evaluate(
    ({ BrowserWindow, webContents }) => webContents.getFocusedWebContents()?.id === BrowserWindow.getAllWindows()[0]!.webContents.id,
  );
const command = (page: Page, data: Record<string, unknown>) =>
  page.evaluate((value) => window.studio.workbench.command({ ...value, commandId: crypto.randomUUID() } as never), data);

async function launch(options: { userData?: string } = {}) {
  const launched = await launchApp({ sbxBin, ...options });
  await expect.poll(async () => (await browserState(launched.page)).loading).toBe(false);
  await expect(selectButton(launched.page)).toBeEnabled();
  return launched;
}
/** 网页 + Agent 会话左右分屏（O01 的起点）。 */
async function splitWithSession(app: ElectronApplication, page: Page) {
  await paneMenu(app, page, '左右分屏', 0);
  await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览', null]);
  await tabButton(page, 'Agent 会话').click();
  await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
  // 回到网页窗格；之后的点选从网页工具栏发起。
  await page
    .locator('.workspace-pane:visible')
    .first()
    .getByRole('button', { name: /^聚焦窗格/ })
    .click();
}
/** 在空间切换器中新建空间（新空间没有会话），并在其中打开演示网页。 */
async function newSpaceWithPage(app: ElectronApplication, page: Page, name: string, tabTitle: string) {
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  const switcher = page.getByRole('dialog', { name: '切换空间' });
  await switcher.getByRole('button', { name: '新建空间', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建空间' });
  await create.getByLabel('名称').fill(name);
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(create).not.toBeVisible();
  const form = await openNewTabForm(app, page, '网页');
  await form.getByLabel('名称').fill(tabTitle);
  await form.getByLabel('网页地址', { exact: true }).fill(DEMO);
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect.poll(async () => (await active(page)).resources.find((r) => r.kind === 'web')?.preview?.loading).toBe(false);
  await expect(selectButton(page)).toBeEnabled();
}
async function selectSpace(page: Page, name: string) {
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  const switcher = page.getByRole('dialog', { name: '切换空间' });
  await switcher.getByRole('button', { name: new RegExp(`${name}.*个标签`) }).click();
  await expect(switcher).not.toBeVisible();
  await expect.poll(async () => (await active(page)).name).toBe(name);
  await expect(page.locator('.workspace-panes').filter({ has: page.locator('.workspace-pane:visible') })).toHaveAttribute(
    'aria-label',
    `${name}工作现场`,
  );
}

test('O01 / O04a / O04b / O05：网页 + 会话分屏，「选择元素」→ 点元素 → 输入后 Enter 共 3 步；不切子页，原生网页始终可见', async () => {
  const { app, page } = await launch();
  try {
    await splitWithSession(app, page);
    const region = sessionRegion(page);
    const conversationView = region.getByRole('navigation', { name: '会话视图' }).getByRole('button', { name: '对话', exact: true });
    await expect(conversationView).toHaveAttribute('aria-pressed', 'true');
    // 默认接收者在开始采集前就显示：同屏的 Agent 会话。
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：Agent 会话');
    const before = await sessionNamed(page, 'Agent 会话');
    let steps = 0;

    // 第 1 步：「选择元素」直接进入点选（不再只给提示，也不经弹层）。
    await selectButton(page).click();
    steps++;
    await expect(pickingButton(page)).toBeVisible();
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('pending');
    expect(await nativeVisible(app)).toBe(true);

    // 第 2 步：在网页里点元素。会话原位更新：不跳到「上下文」，引用标签出现在输入框上方，焦点交回会话输入框。
    await clickInPage(app, ELEMENT);
    steps++;
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('completed');
    const captured = await sessionNamed(page, 'Agent 会话');
    expect(captured.taskTargetRef).toEqual({ kind: 'web', resourceId: required(captured.contextTarget).resourceId });
    await expect(region.getByRole('group', { name: '页面引用' })).toContainText(CHIP);
    await expect(conversationView).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByRole('heading', { name: '任务上下文' })).toHaveCount(0);
    await expect(composer(region)).toBeFocused();
    await expect.poll(() => workbenchFocused(app)).toBe(true);
    expect(await nativeVisible(app)).toBe(true);
    expect(await paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
    await windowShots(app, page, 'ops-b3/o01-captured-in-place');

    // 第 3 步：直接输入并按 Enter（输入文字不计步）。发送 = 确认任务 + 开始运行，任务版本冻结页面引用。
    await page.keyboard.type('把新建任务按钮改成蓝色');
    await page.keyboard.press('Enter');
    steps++;
    await expect.poll(async () => (await active(page)).runs.length).toBe(1);
    const sent = await sessionNamed(page, 'Agent 会话');
    const version = required(sent.taskVersions.at(-1));
    expect(version).toMatchObject({ goal: '把新建任务按钮改成蓝色', targetRef: captured.taskTargetRef });
    expect(version.capture?.captureId).toBe(captured.context?.captureId);
    expect(steps).toBe(3);
    expect(before.taskVersions).toHaveLength(0);
    expect(await nativeVisible(app)).toBe(true);
    await expect(conversationView).toHaveAttribute('aria-pressed', 'true');

    // R8 的另一半：接收者是已有消息的会话时，取消采集不关闭它的标签。
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).conversation?.messages.length ?? 0).toBeGreaterThan(0);
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await expect.poll(async () => (await active(page)).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(true);
    await pickingButton(page).click();
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('cancelled');
    expect((await active(page)).tabs.map((t) => t.title)).toContain('Agent 会话');
  } finally {
    await app.close();
  }
});

test('O02 / O04a / R8：空间没有会话时点选——发起时自动新建并显示在接收者按钮上，完成后在网页旁分屏；取消时关闭未使用的自动会话标签', async () => {
  const { app, page } = await launch();
  try {
    await newSpaceWithPage(app, page, '点选空间742', '成员页');
    expect((await active(page)).sessions).toHaveLength(0);
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：将自动新建「成员页 · 会话」');

    // 再点按钮取消：本次自动新建且没有消息的会话关闭标签（会话无法用现有命令移除，留在后台资源中）。
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：成员页 · 会话');
    const first = await sessionNamed(page, '成员页 · 会话');
    expect(await paneTabs(page)).toEqual(['成员页']);
    await expect.poll(async () => (await active(page)).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(true);
    await pickingButton(page).click();
    await expect.poll(async () => (await active(page)).tabs.some((t) => t.targetRef.resourceId === first.resourceId)).toBe(false);
    await expect(pickingButton(page)).toHaveCount(0);
    expect((await active(page)).sessions.find((s) => s.sessionId === first.sessionId)?.context).toBeNull();

    // 页面里按 Esc 取消：同样关闭。
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    const second = (await active(page)).sessions.at(-1)!;
    expect(second.sessionId).not.toBe(first.sessionId);
    await expect.poll(async () => (await active(page)).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(true);
    await escapeInPage(app);
    await expect.poll(async () => (await active(page)).tabs.some((t) => t.targetRef.resourceId === second.resourceId)).toBe(false);

    // 完成：自动新建的会话成为接收者，在网页旁分屏出现，焦点在它的输入框。
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    const third = (await active(page)).sessions.at(-1)!;
    await clickInPage(app, ELEMENT);
    await expect.poll(() => paneTabs(page)).toEqual(['成员页', '成员页 · 会话']);
    await expect(composer(sessionRegion(page, '成员页 · 会话'))).toBeFocused();
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：成员页 · 会话');
    expect((await active(page)).sessions.find((s) => s.sessionId === third.sessionId)?.context?.element.text).toContain('新建任务');
    await windowShots(app, page, 'ops-b3/o02-auto-session-split');
  } finally {
    await app.close();
  }
});

// 在 Main 开始点选前持有 IPC；不用时间延迟猜测 CDP 是否已进入 inspect mode。
for (const cancellation of ['button', 'escape'] as const) {
  test(`R8 / O03d：准备点选期间重复触发只创建一个请求，就绪后 ${cancellation} 取消并关闭自动会话`, async () => {
    const { app, page } = await launch();
    try {
      await newSpaceWithPage(app, page, `取消时序 ${cancellation}`, '时序页面');
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, request?: Record<string, unknown>) => Promise<unknown>;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
        const original = handlers.get('workbench:command');
        if (!original) throw new Error('missing command handler');
        const gate = { calls: [] as Record<string, unknown>[], release: null as (() => void) | null };
        (globalThis as unknown as { __captureStartGate: typeof gate }).__captureStartGate = gate;
        ipcMain.removeHandler('workbench:command');
        ipcMain.handle('workbench:command', async (event, request?: Record<string, unknown>) => {
          if (['createTab', 'captureContext', 'cancelCapture'].includes(String(request?.['type']))) gate.calls.push({ ...request });
          if (request?.['type'] === 'captureContext') {
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
            gate.release = null;
          }
          return original(event, request);
        });
      });
      await selectButton(page).click();
      await expect
        .poll(() =>
          app.evaluate(() => !!(globalThis as unknown as { __captureStartGate: { release: unknown } }).__captureStartGate.release),
        )
        .toBe(true);
      const preparing = browserRoot(page).getByRole('button', { name: '正在准备点选…', exact: true });
      await expect(preparing).toHaveAttribute('aria-busy', 'true');
      await expect(pickingButton(page)).toHaveCount(0);
      await preparing.click();
      await preparing.click();
      const pending = required((await active(page)).sessions[0]);
      expect((await active(page)).sessions).toHaveLength(1);
      expect(pending.captureRequest).toBeNull();
      expect((await active(page)).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(false);
      const started = await app.evaluate(() => {
        const gate = (globalThis as unknown as { __captureStartGate: { calls: Record<string, unknown>[]; release: (() => void) | null } })
          .__captureStartGate;
        if (!gate.release) throw new Error('capture start is not held');
        const calls = gate.calls;
        gate.release();
        return calls;
      });
      expect(started.filter((c) => c['type'] === 'createTab')).toHaveLength(1);
      expect(started.filter((c) => c['type'] === 'captureContext')).toHaveLength(1);
      expect(started.filter((c) => c['type'] === 'cancelCapture')).toHaveLength(0);
      await expect(pickingButton(page)).toBeVisible();
      await expect.poll(async () => (await active(page)).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(true);
      const requestId = required(started.find((c) => c['type'] === 'captureContext'))['requestId'];
      expect((await active(page)).sessions[0]?.captureRequest).toMatchObject({ requestId, state: 'pending' });
      if (cancellation === 'button') await pickingButton(page).click();
      else await escapeInPage(app);
      await expect.poll(async () => (await active(page)).sessions[0]?.captureRequest?.state).toBe('cancelled');
      await expect.poll(async () => (await active(page)).tabs.some((t) => t.targetRef.resourceId === pending.resourceId)).toBe(false);
      expect((await active(page)).sessions).toHaveLength(1);
      expect((await active(page)).sessions[0]?.captureRequest?.requestId).toBe(requestId);
      expect((await active(page)).sessions[0]?.context).toBeNull();
      expect((await active(page)).resources.find((r) => r.kind === 'web')?.preview?.picking).toBe(false);
      await expect(selectButton(page)).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

test('O02a：默认接收者顺序——显式有效选择 > 同屏最近活动 > 本空间最近活动；同屏都无活动时按窗格顺序；显式选择关闭后回落', async () => {
  const { app, page } = await launch();
  try {
    // 网页 | （Agent 会话 / 会话 B）：两个同屏会话都没有活动记录，按窗格顺序取 Agent 会话。
    expect(
      (await command(page, { type: 'createTab', workspaceId: 'taskflow-demo', kind: 'session', title: '会话 B', activate: false })).ok,
    ).toBe(true);
    await splitWithSession(app, page);
    await page
      .locator('.workspace-pane')
      .nth(1)
      .getByRole('button', { name: /^聚焦窗格/ })
      .click();
    await paneMenu(app, page, '上下分屏', 1);
    await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话', null]);
    await tabButton(page, '会话 B').click();
    await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话', '会话 B']);
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：Agent 会话');
    // 在会话 B 里操作后它成为同屏最近活动的会话。
    await composer(sessionRegion(page, '会话 B')).click();
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：会话 B');
    // 显式选择优先（菜单以单选标出当前接收者）。
    expect(
      (await command(page, { type: 'createTab', workspaceId: 'taskflow-demo', kind: 'session', title: '会话 C', activate: false })).ok,
    ).toBe(true);
    const menu = await pickNativeMenu(app, receiverButton(page), '会话 C');
    expect(menu.items).toEqual([
      { label: 'Agent 会话', enabled: true, checked: false },
      { label: '会话 B', enabled: true, checked: true },
      { label: '会话 C', enabled: true, checked: false },
      { label: '新建会话', enabled: true },
      { label: '打开接收会话', enabled: true },
    ]);
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：会话 C');
    // 显式选择的会话被关闭：回落到同屏最近活动。
    await tabMenu(app, page, '会话 C', '关闭标签（保留后台执行）');
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：会话 B');
    // 同屏不再有会话：取本空间最近活动的会话。
    await paneMenu(app, page, '关闭窗格（标签保留）', 2);
    await paneMenu(app, page, '关闭窗格（标签保留）', 1);
    await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览']);
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：会话 B');
  } finally {
    await app.close();
  }
});

test('O03 / O03d：采集途中改接收者只影响下一次；连点只发起一个请求、不新建会话', async () => {
  const { app, page } = await launch();
  try {
    await splitWithSession(app, page);
    const sessions = (await active(page)).sessions.length;
    // 连点：只有一个请求，仍在选择中，没有自动新建会话。
    await selectButton(page).dblclick();
    await expect(pickingButton(page)).toBeVisible();
    await page.waitForTimeout(300);
    await expect(pickingButton(page)).toBeVisible();
    const pending = required((await sessionNamed(page, 'Agent 会话')).captureRequest);
    expect(pending.state).toBe('pending');
    expect((await active(page)).sessions).toHaveLength(sessions);

    // 采集途中经接收者菜单「新建会话」：只设定之后的接收者，不开始采集，也不占用窗格。
    await pickNativeMenu(app, receiverButton(page), '新建会话');
    await expect(receiverButton(page)).toHaveAccessibleName('接收会话：TaskFlow 预览 · 会话');
    expect(await paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
    expect((await sessionNamed(page, 'Agent 会话')).captureRequest?.requestId).toBe(pending.requestId);
    await clickInPage(app, ELEMENT);
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('completed');
    expect((await sessionNamed(page, 'Agent 会话')).context).not.toBeNull();
    expect((await sessionNamed(page, 'TaskFlow 预览 · 会话')).context).toBeNull();

    // 下一次采集归新接收者；它是用户显式新建的，取消后不关闭（R8 只针对本次自动新建）。
    await selectButton(page).click();
    await expect.poll(async () => (await sessionNamed(page, 'TaskFlow 预览 · 会话')).captureRequest?.state).toBe('pending');
    await pickingButton(page).click();
    await expect.poll(async () => (await sessionNamed(page, 'TaskFlow 预览 · 会话')).captureRequest?.state).toBe('cancelled');
    expect((await active(page)).tabs.map((t) => t.title)).toContain('TaskFlow 预览 · 会话');
  } finally {
    await app.close();
  }
});

for (const openWith of ['pointer', 'keyboard'] as const) {
  test(`O04a ${openWith}：窄窗或四窗格已满只提示「已采集到 {会话} · 打开」，不改布局、不抢焦点；没有可见会话时放入空窗格`, async () => {
    const { app, page } = await launch();
    try {
      // 窄窗（<1080px）：只投影活动窗格，只提示。
      await setWindowSize(app, 1000, 760);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000);
      const narrow = await paneTabs(page);
      await pickNativeMenu(app, receiverButton(page), 'Agent 会话');
      await selectButton(page).click();
      await expect(pickingButton(page)).toBeVisible();
      await clickInPage(app, ELEMENT);
      await expect(browserSlot(page).filter({ hasText: '已采集到 Agent 会话' })).toBeVisible();
      expect(await paneTabs(page)).toEqual(narrow);
      expect(await nativeVisible(app)).toBe(true);
      await windowShots(app, page, 'ops-b3/o04a-narrow-hint');
      await setWindowSize(app, 1440, 900);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);

      // 空窗格：网页 | 空窗格；显式选择的 Agent 会话不在任何窗格中，放入空窗格。
      await paneMenu(app, page, '左右分屏');
      await page
        .locator('.workspace-pane')
        .first()
        .getByRole('button', { name: /^聚焦窗格/ })
        .click();
      await selectButton(page).click();
      await expect(pickingButton(page)).toBeVisible();
      await clickInPage(app, ELEMENT);
      await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
      await expect(composer(sessionRegion(page, 'Agent 会话'))).toBeFocused();

      // 四窗格已满：接收者不在任何窗格。
      for (const title of ['会话 C', '会话 D'])
        expect((await command(page, { type: 'createTab', workspaceId: 'taskflow-demo', kind: 'session', title, activate: false })).ok).toBe(
          true,
        );
      await paneMenu(app, page, '上下分屏', 1);
      await tabButton(page, '开发终端').click();
      await page
        .locator('.workspace-pane')
        .first()
        .getByRole('button', { name: /^聚焦窗格/ })
        .click();
      await paneMenu(app, page, '上下分屏');
      await tabButton(page, '会话 C').click();
      await expect.poll(async () => (await paneTabs(page)).length).toBe(4);
      const full = await paneTabs(page);
      await page
        .locator('.workspace-pane')
        .first()
        .getByRole('button', { name: /^聚焦窗格/ })
        .click();
      await pickNativeMenu(app, receiverButton(page), '会话 D');
      await selectButton(page).click();
      await expect(pickingButton(page)).toBeVisible();
      await clickInPage(app, ELEMENT);
      const hint = browserSlot(page).filter({ hasText: '已采集到 会话 D' });
      await expect(hint).toBeVisible();
      await expect(hint).toHaveAttribute('data-status-channel', 'notice');
      expect(await paneTabs(page)).toEqual(full);
      expect((await sessionNamed(page, '会话 D')).context).not.toBeNull();
      await expect(composer(sessionRegion(page, 'Agent 会话'))).not.toBeFocused();
      await windowShots(app, page, 'ops-b3/o04a-four-panes-hint');
      // 审计实际定位命令：提示消失不能替代动作已执行的证明。
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
        const original = handlers.get('workbench:command');
        if (!original) throw new Error('workbench:command handler missing');
        const seam = globalThis as unknown as { __b3Locations: unknown[] };
        seam.__b3Locations = [];
        handlers.set('workbench:command', async (...args) => {
          const result = await original(...args);
          const command = args[1] as { type: string };
          if (command.type === 'locateSession') seam.__b3Locations.push(command);
          return result;
        });
      });
      const open = hint.getByRole('button', { name: '打开', exact: true });
      // Playwright 的 DOM 点击 / focus 不会把 Electron 的 native 焦点从网页切回 renderer。
      // 手动打开的前提是用户已经进入工作台；自动展开的焦点交还另由 O01 核对。
      expect(await page.evaluate(() => window.studio.shell.focusWorkbench())).toBe(true);
      await expect.poll(() => workbenchFocused(app)).toBe(true);
      if (openWith === 'pointer') await open.click();
      else {
        await open.focus();
        await expect(hint).toBeVisible();
        await open.press('Enter');
      }
      await expect
        .poll(() => app.evaluate(() => (globalThis as unknown as { __b3Locations: unknown[] }).__b3Locations))
        .toEqual([
          expect.objectContaining({
            type: 'locateSession',
            workspaceId: 'taskflow-demo',
            sessionId: (await sessionNamed(page, '会话 D')).sessionId,
          }),
        ]);
      await expect(sessionRegion(page, '会话 D')).toBeVisible();
      await expect(sessionRegion(page, '会话 D').getByRole('button', { name: '对话', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect.poll(() => workbenchFocused(app)).toBe(true);
    } finally {
      await app.close();
    }
  });
}

test('O03b / O03c / O04b：采集途中关闭接收会话标签或窗格、导航后：只保存证据并提示，不重开窗格、不新建会话、不抢焦点', async () => {
  const { app, page } = await launch();
  try {
    await splitWithSession(app, page);
    const sessions = (await active(page)).sessions.length;
    // 关闭接收会话的标签。
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await tabMenu(app, page, 'Agent 会话', '关闭标签（保留后台执行）');
    await clickInPage(app, ELEMENT);
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('completed');
    await expect(browserSlot(page).filter({ hasText: '已采集到 Agent 会话' })).toBeVisible();
    expect(await paneTabs(page)).toEqual(['TaskFlow 预览', null]);
    expect((await active(page)).sessions).toHaveLength(sessions);
    expect((await active(page)).tabs.map((t) => t.title)).not.toContain('Agent 会话');

    // 关闭接收会话所在窗格：已关闭的窗格不被恢复。先把会话重新打开到空出的窗格。
    await page
      .locator('.workspace-pane')
      .nth(1)
      .getByRole('button', { name: /^聚焦窗格/ })
      .click();
    await page.getByText('后台资源 / 已关闭标签').click();
    await page.getByRole('button', { name: 'Agent 会话 · 重新打开' }).click();
    await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
    await page
      .locator('.workspace-pane')
      .first()
      .getByRole('button', { name: /^聚焦窗格/ })
      .click();
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await paneMenu(app, page, '关闭窗格（标签保留）', 1);
    await expect.poll(() => paneTabs(page)).toEqual(['TaskFlow 预览']);
    await clickInPage(app, ELEMENT);
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('completed');
    await expect(browserSlot(page).filter({ hasText: '已采集到 Agent 会话' })).toBeVisible();
    expect(await paneTabs(page)).toEqual(['TaskFlow 预览']);

    // 用户在采集途中导航（聚焦另一窗格）：焦点不被移动。
    await paneMenu(app, page, '左右分屏');
    await tabButton(page, 'Agent 会话').click();
    await page
      .locator('.workspace-pane')
      .first()
      .getByRole('button', { name: /^聚焦窗格/ })
      .click();
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await page
      .locator('.workspace-pane')
      .nth(1)
      .getByRole('button', { name: /^聚焦窗格/ })
      .click();
    await clickInPage(app, ELEMENT);
    await expect(browserSlot(page).filter({ hasText: '已采集到 Agent 会话' })).toBeVisible();
    await expect(composer(sessionRegion(page, 'Agent 会话'))).not.toBeFocused();

    // 点选中页面导航：Main 取消本次采集，导航后的回执不写入证据（O03c）。
    const evidence = (await sessionNamed(page, 'Agent 会话')).context?.captureId;
    await page
      .locator('.workspace-pane')
      .first()
      .getByRole('button', { name: /^聚焦窗格/ })
      .click();
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await page.getByLabel('页面地址').fill('wsl-demo://taskflow/members.html');
    await page.getByLabel('页面地址').press('Enter');
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).captureRequest?.state).toBe('cancelled');
    expect((await sessionNamed(page, 'Agent 会话')).context?.captureId).toBe(evidence);
    expect(await paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
  } finally {
    await app.close();
  }
});

test('O03a：采集途中切空间——迟到的结果归原空间与会话，不改任何空间布局，不抢焦点', async () => {
  const { app, page } = await launch();
  try {
    await newSpaceWithPage(app, page, '另一空间742', '另一网页');
    await selectSpace(page, 'TaskFlow');
    await expect(selectButton(page)).toBeEnabled();
    await splitWithSession(app, page);
    // 让采集结果在两张截图都已截取（网页仍可见）之后停住：测试侧在 Main 中包住可见原生网页的 capturePage，
    // 第二张（元素裁剪）截好后等待放行，以便在结果到达前切换空间。产品代码没有对应路径。
    await app.evaluate(({ BrowserWindow }) => {
      const views = BrowserWindow.getAllWindows()[0]!.contentView.children as Electron.WebContentsView[];
      const view = views.find((candidate) => candidate.webContents && candidate.getVisible())!;
      const wc = view.webContents;
      const original = wc.capturePage.bind(wc);
      const seam = globalThis as unknown as { __b3Release: () => void; __b3Held: boolean };
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      seam.__b3Release = release;
      seam.__b3Held = false;
      let calls = 0;
      wc.capturePage = (async (...args: Parameters<typeof wc.capturePage>) => {
        const image = await original(...args);
        if (++calls === 2) {
          seam.__b3Held = true;
          await gate;
        }
        return image;
      }) as typeof wc.capturePage;
    });
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await clickInPage(app, ELEMENT);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __b3Held: boolean }).__b3Held)).toBe(true);
    await selectSpace(page, '另一空间742');
    const other = await active(page);
    const otherTabs = await paneTabs(page);
    await app.evaluate(() => (globalThis as unknown as { __b3Release: () => void }).__b3Release());
    const origin = async () => required((await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo'));
    await expect.poll(async () => (await origin()).sessions.find((s) => s.title === 'Agent 会话')?.captureRequest?.state).toBe('completed');
    // 当前空间不受影响：布局、会话与焦点都不变。
    expect((await active(page)).workspaceId).toBe(other.workspaceId);
    expect(await paneTabs(page)).toEqual(otherTabs);
    expect((await active(page)).sessions).toHaveLength(0);
    await expect(page.getByRole('textbox', { name: '会话消息', exact: true })).toHaveCount(0);
    // 回到原空间：布局未被改动，提示留在原网页的状态槽。
    await selectSpace(page, 'TaskFlow');
    expect(await paneTabs(page)).toEqual(['TaskFlow 预览', 'Agent 会话']);
    await expect(browserSlot(page).filter({ hasText: '已采集到 Agent 会话' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('O05 / O05a / O05b：唯一目标输入、任务设置（范围、验收、文件/终端目标、Harness）、单一目标替换、失败保留草稿、重新运行用原版本', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-b3-send-'));
  let { app, page } = await launch({ userData });
  try {
    await splitWithSession(app, page);
    const region = sessionRegion(page);
    // O05：「任务」视图没有重复的目标输入框与「确认任务」；会话里只有底部一个目标输入。
    await region.getByRole('button', { name: '任务', exact: true }).click();
    for (const gone of ['修改目标', '附加目标（明确选择）']) await expect(region.getByLabel(gone)).toHaveCount(0);
    for (const gone of ['确认任务（生成新版本）', '采集目标元素', '开始运行'])
      await expect(region.getByRole('button', { name: gone })).toHaveCount(0);
    await expect(region.getByRole('textbox')).toHaveCount(1);
    await region.getByRole('button', { name: '对话', exact: true }).click();

    // O05a：任务设置默认折叠，显示摘要；展开后保存范围、验收、终端目标与执行 Agent。
    const toggle = region.getByRole('button', { name: /^任务设置/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('范围 0 · 验收 0');
    await toggle.click();
    const settings = region.getByRole('group', { name: '任务设置' });
    await settings.getByLabel('允许修改范围（每行一条）').fill('demo/taskflow/index.html');
    await settings.getByLabel('验收条件（每行一条）').fill('按钮为蓝色\n刷新后保留');
    await settings.getByLabel('附加目标（文件 / 终端 / SSH）').selectOption({ label: '开发终端' });
    await expect(settings.getByLabel('执行 Agent')).toBeVisible();
    const harness = settings.getByLabel('执行 Agent');
    const option = await harness.locator('option').nth(1).getAttribute('value');
    if (option) await harness.selectOption(option);
    await expect
      .poll(async () => {
        const s = await sessionNamed(page, 'Agent 会话');
        return [s.taskAllowedScopes, s.taskAcceptance, s.taskTargetRef?.kind, !!s.harnessSelection === !!option];
      })
      .toEqual([['demo/taskflow/index.html'], ['按钮为蓝色', '刷新后保留'], 'terminal', true]);
    await toggle.click();
    await expect(toggle).toContainText('范围 1 · 验收 2 · 开发终端');
    await expect(region.getByRole('group', { name: '页面引用' })).toHaveCount(0);

    // 单一目标：新的采集替换设置中的终端目标（引用标签出现）；再选终端又替换引用标签。
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await clickInPage(app, ELEMENT);
    await expect(region.getByRole('group', { name: '页面引用' })).toContainText(CHIP);
    await expect(toggle).toContainText('范围 1 · 验收 2');
    await expect(toggle).not.toContainText('开发终端');
    const reference = region.getByRole('group', { name: '页面引用' });
    await reference.getByRole('button', { name: CHIP, exact: true }).click();
    await expect(reference.getByRole('img', { name: /引用(元素|页面)截图/ })).toBeVisible();
    await expect(reference).toContainText('现场适用性：有效');
    await toggle.click();
    await settings.getByLabel('附加目标（文件 / 终端 / SSH）').selectOption({ label: '开发终端' });
    await expect(region.getByRole('group', { name: '页面引用' })).toHaveCount(0);
    expect((await sessionNamed(page, 'Agent 会话')).context).not.toBeNull();
    await toggle.click();

    // IME 组词期间 Enter 不发送；之后正常发送（防重复提交：连点只生成一个版本）。
    const input = composer(region);
    await input.fill('以终端为目标的任务');
    await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
    await page.waitForTimeout(300);
    expect((await sessionNamed(page, 'Agent 会话')).taskVersions).toHaveLength(0);
    await region.getByRole('button', { name: '发送', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect.poll(async () => (await active(page)).runs.length).toBe(1);
    const first = required((await sessionNamed(page, 'Agent 会话')).taskVersions.at(-1));
    expect((await sessionNamed(page, 'Agent 会话')).taskVersions).toHaveLength(1);
    expect(first).toMatchObject({
      targetRef: { kind: 'terminal' },
      allowedScopes: ['demo/taskflow/index.html'],
      acceptance: ['按钮为蓝色', '刷新后保留'],
    });
    await expect.poll(async () => (await active(page)).runs.at(-1)?.state).toBe('completed');

    // O05b：发送失败保留草稿——引用的页面已导航（现场失效）时确认被拒绝。
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await clickInPage(app, ELEMENT);
    await expect(region.getByRole('group', { name: '页面引用' })).toBeVisible();
    await page.getByLabel('页面地址').fill('wsl-demo://taskflow/members.html');
    await page.getByLabel('页面地址').press('Enter');
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).contextApplicability).toBe('stale');
    await input.fill('页面已失效时发送');
    await region.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.toasts')).toContainText('页面现场已失效');
    await expect(input).toHaveValue('页面已失效时发送');
    expect((await sessionNamed(page, 'Agent 会话')).taskVersions).toHaveLength(1);

    // 历史版本「重新运行」使用原版本，不重建目标。
    await region.getByRole('button', { name: '任务', exact: true }).click();
    await region.getByRole('button', { name: '重新运行', exact: true }).click();
    await expect.poll(async () => (await active(page)).runs.length).toBe(2);
    const rerun = required((await active(page)).runs.at(-1));
    expect(rerun.taskVersionId).toBe(first.taskVersionId);
    expect(rerun.targetRef).toEqual(first.targetRef);
    expect((await sessionNamed(page, 'Agent 会话')).taskVersions).toHaveLength(1);
    await expect.poll(async () => (await active(page)).runs.at(-1)?.state).toBe('completed');

    // 删除旧下拉框后已有目标选择不丢失：重启后设置里仍是终端目标。
    await region.getByRole('button', { name: '对话', exact: true }).click();
    await toggle.click();
    await settings.getByLabel('附加目标（文件 / 终端 / SSH）').selectOption({ label: '开发终端' });
    await expect.poll(async () => (await sessionNamed(page, 'Agent 会话')).taskTargetRef?.kind).toBe('terminal');
    await app.close();
    ({ app, page } = await launch({ userData }));
    await tabButton(page, 'Agent 会话').click();
    const reopened = sessionRegion(page).getByRole('button', { name: /^任务设置/ });
    await expect(reopened).toContainText('开发终端');
    await reopened.click();
    await expect(sessionRegion(page).getByLabel('附加目标（文件 / 终端 / SSH）')).toHaveValue(
      required((await active(page)).resources.find((r) => r.title === '开发终端')).resourceId,
    );
  } finally {
    await app.close();
  }
});

test('O05e：普通网页采集与移除引用都不改变工程开关；移除引用保留采集证据', async () => {
  const { app, page } = await launch();
  try {
    await splitWithSession(app, page);
    const region = sessionRegion(page);
    await expect(region.getByRole('group', { name: '工程绑定' })).toContainText('未选择工程');
    await selectButton(page).click();
    await expect(pickingButton(page)).toBeVisible();
    await clickInPage(app, ELEMENT);
    const reference = region.getByRole('group', { name: '页面引用' });
    await expect(reference).toContainText(CHIP);
    // 普通网页（不是受管 App 页面）的采集不推断工程。
    await expect(region.getByRole('group', { name: '工程绑定' })).toContainText('未选择工程');
    await reference.getByRole('button', { name: `移除引用：${CHIP}`, exact: true }).click();
    await expect(reference).toHaveCount(0);
    const removed = await sessionNamed(page, 'Agent 会话');
    expect(removed.taskTargetRef).toBeNull();
    expect(removed.context?.element.text).toContain('新建任务');
    expect(removed.taskProject).toBeNull();
    await expect(region.getByRole('group', { name: '工程绑定' })).toContainText('未选择工程');
  } finally {
    await app.close();
  }
});
