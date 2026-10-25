import { writeFile } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  clickAppMenu,
  launchApp,
  paneMenu,
  previewClick,
  previewElementCenter,
  previewInfo,
  setWindowSize,
  workspaceSnapshot,
  windowShots,
  workshopNavigate,
} from './helpers';
let app: ElectronApplication, page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  // 启用诊断通道：会话现场的诊断详情已移到诊断面板（plan §4）。
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname, debugStatus: true }));
  await setWindowSize(app, 1440, 900);
});
test.afterAll(async () => {
  await app?.close();
});
const session = () => page.getByRole('region', { name: 'Agent 会话内容' });

test('启动：窗口、安全边界与 Browser 区真实加载', async () => {
  await expect(page.getByRole('button', { name: 'TaskFlow 预览', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      require: typeof (window as Window & { require?: unknown }).require,
      process: typeof (window as Window & { process?: unknown }).process,
      // 诊断通道在本文件中启用：恰为七个公开键加 `debug`（未启用时的七键断言见 workspace-debug.spec.ts）。
      studio: Object.keys(window.studio),
    })),
  ).toEqual({
    require: 'undefined',
    process: 'undefined',
    studio: ['setup', 'workbench', 'chat', 'app', 'execution', 'workflow', 'shell', 'debug'],
  });
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
  const info = await previewInfo(app);
  expect(info.url).toBe('wsl-demo://taskflow/index.html');
  expect(info.visible).toBe(true);
  expect(
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView;
      return view.webContents.executeJavaScript(
        '({studio:typeof window.studio,require:typeof window.require,process:typeof window.process})',
      );
    }),
  ).toEqual({ studio: 'undefined', require: 'undefined', process: 'undefined' });
  const host = await page.locator('.preview-host:visible').boundingBox();
  expect(host).not.toBeNull();
  expect(Math.abs(host!.x - info.bounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(host!.width - info.bounds.width)).toBeLessThanOrEqual(1);
  await windowShots(app, page, 'workbench-start');
});

test('点选：「选择元素」一步采集到同屏会话，采集摘要、截图与页面身份，先采集后确认不会崩溃', async () => {
  await paneMenu(app, page, '左右分屏');
  await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
  // OPS-1 S1：「选择元素」直接进入点选（接收者为同屏的 Agent 会话），不再先给指引、也不需在「任务」页附加目标。
  await page.getByRole('button', { name: '选择元素', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
  await previewClick(app, await previewElementCenter(app, '[data-testid="due-1"]'));
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.captureRequest?.state).toBe('completed');
  // 完成后不跳到「上下文」；现场详情仍在「上下文」视图。
  await session().getByRole('button', { name: '上下文', exact: true }).click();
  await expect(session()).toContainText('现场适用性：有效');
  await expect(session().locator('img.context-image')).toHaveCount(2);
  // 产品界面不再外露「诊断详情」；采集条目移到诊断面板，面板内可查看并标注不可导出。
  await expect(session().getByText('诊断详情')).toHaveCount(0);
  expect(await clickAppMenu(app, '诊断')).toBe('CmdOrCtrl+Alt+Shift+D');
  const debugPanel = page.getByRole('dialog', { name: '诊断', exact: true });
  await expect(debugPanel).toBeVisible();
  const liveSession = debugPanel.getByRole('region', { name: '当前会话现场（不可导出）' });
  await expect(liveSession).toContainText('不可导出');
  await liveSession.getByRole('button', { name: '查看', exact: true }).click();
  const captureJson = liveSession.getByLabel('会话现场 JSON（不可导出）');
  await expect(captureJson).toContainText('webContentsId');
  await expect(captureJson).toContainText('未设置');
  await page.keyboard.press('Escape');
  await expect(debugPanel).toHaveCount(0);
  const s = await workspaceSnapshot(page);
  expect(s.workspaces[0]?.sessions[0]?.taskVersions).toHaveLength(0);
  await windowShots(app, page, 'workbench-context-before-confirm');
});

test('任务确认：中文目标生成权威不可变版本，重复点击不生成双版本', async () => {
  await session().getByRole('button', { name: '任务', exact: true }).click();
  // OPS-1 S2：目标只在底部输入框；范围与验收在「任务设置」；「发送」= 确认任务 + 开始运行。
  await session().getByRole('textbox', { name: '会话消息', exact: true }).fill('修复截止日期字段，保存之后刷新仍保留。');
  await session()
    .getByRole('button', { name: /^任务设置/ })
    .click();
  await session().getByLabel('允许修改范围（每行一条）').fill('src/task.ts');
  await session().getByLabel('验收条件（每行一条）').fill('保存刷新后保留\nAPI字段一致');
  const confirm = session().getByRole('button', { name: '发送', exact: true });
  await confirm.evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect(session()).toContainText('任务 v1');
  const s = await workspaceSnapshot(page),
    versions = s.workspaces[0]!.sessions[0]!.taskVersions;
  expect(versions).toHaveLength(1);
  expect(versions[0]?.capture?.element.text).toContain('未设置');
  expect(versions[0]?.goal).toBe('修复截止日期字段，保存之后刷新仍保留。');
  expect(versions[0]?.allowedScopes).toEqual(['src/task.ts']);
  expect(versions[0]?.acceptance).toEqual(['保存刷新后保留', 'API字段一致']);
});

test('导航：页面跳转后旧现场失效，历史版本仍保留原目标', async () => {
  await previewClick(app, await previewElementCenter(app, 'a[href="task.html?id=1"]'));
  await expect.poll(async () => (await previewInfo(app)).url).toContain('task.html?id=1');
  await session().getByRole('button', { name: '上下文', exact: true }).click();
  await expect(session()).toContainText('现场适用性：已失效');
  const s = await workspaceSnapshot(page);
  expect(s.workspaces[0]!.sessions[0]!.taskVersions[0]?.capture?.page.url).toBe('wsl-demo://taskflow/index.html');
  await session().getByRole('button', { name: '重新选择元素' }).click();
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.picking)
    .toBe(true);
  await previewClick(app, await previewElementCenter(app, '[data-testid="edit-task"]'));
  await expect(session()).toContainText('现场适用性：有效');
});

test('选择模式中导航：退出选择模式，之后页面点击正常生效', async () => {
  await session().getByRole('button', { name: '重新选择元素' }).click();
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.picking)
    .toBe(true);
  const address = page.getByLabel('页面地址');
  await address.fill('wsl-demo://taskflow/members.html');
  await address.press('Enter');
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/members.html');
  await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toHaveCount(0);
  await previewClick(app, await previewElementCenter(app, 'header a[href="index.html"]'));
  await expect.poll(async () => (await previewInfo(app)).url).toBe('wsl-demo://taskflow/index.html');
});

test('运行、检查、审阅分别记录；没有独立检查器不会显示通过', async () => {
  await session().getByRole('button', { name: '任务', exact: true }).click();
  // 移除页面引用（保留采集证据），只发送文字任务；发送即确认并开始运行。
  await session()
    .getByRole('group', { name: '页面引用' })
    .getByRole('button', { name: /^移除引用：/ })
    .click();
  await expect(session().getByRole('group', { name: '页面引用' })).toHaveCount(0);
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
  await session().getByRole('textbox', { name: '会话消息', exact: true }).fill('只回复中文标记工作台742，不执行任何工具。');
  await session().getByRole('button', { name: '发送', exact: true }).click();
  await expect(session()).toContainText('任务 v2');
  const runState = session().locator('[data-status-key$=":state"][data-status="run:ok"]');
  await expect(runState).toBeVisible();
  await expect(runState).toContainText('执行完成');
  await session().getByRole('button', { name: '检查', exact: true }).click();
  // 检查器未接入（OPS-1 S3）：尚未检查是中性稳态，不提供「运行检查」，状态槽没有检查问题。
  const notChecked = session().locator('[data-status="validation:idle"]');
  await expect(notChecked).toBeVisible();
  await expect(notChecked).toContainText('检查器未接入');
  await expect(session().getByRole('button', { name: '运行检查' })).toHaveCount(0);
  await expect(session().locator('.status-slot').getByText('检查无法执行')).toHaveCount(0);
  await expect(session().getByRole('button', { name: '接受结果' })).toBeDisabled();
  expect((await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)!.validation.state).toBe('not_run');
  // 既有 IPC 命令 runValidation 的 Main 行为未变：仍记录 blocked，检查无法执行是问题，在问题通道里可见，从不显示为通过。
  const latest = (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)!;
  const validated = await page.evaluate(
    (command) => window.studio.workbench.command({ ...command, commandId: crypto.randomUUID() } as never),
    { type: 'runValidation', workspaceId: latest.workspaceId, runId: latest.runId },
  );
  expect(validated.ok).toBe(true);
  await expect(session().locator('.status-slot [data-status-channel="problem"]').filter({ hasText: '检查无法执行' })).toBeVisible();
  await expect(session().locator('[data-status="validation:ok"]')).toHaveCount(0);
  await expect(session()).toContainText('审阅：尚未审阅');
  await expect(session().getByRole('button', { name: '接受结果' })).toBeDisabled();
  await expect(session()).toContainText('审阅：尚未审阅');
  const s = await workspaceSnapshot(page),
    run = s.workspaces[0]!.runs.at(-1)!;
  expect(run.review).toBeNull();
  expect(run.validation.state).toBe('blocked');
});

test('导航与草稿：个人作用域不沿用空间输入，回空间恢复草稿', async () => {
  await session().getByRole('textbox', { name: '会话消息', exact: true }).fill('空间未发送草稿');
  await workshopNavigate(page, '首页');
  const personal = page.getByRole('region', { name: '混合输入' }).getByRole('textbox');
  await expect(personal).toHaveValue('');
  await personal.fill('个人未发送草稿');
  expect((await previewInfo(app)).visible).toBe(false);
  await workshopNavigate(page, '空间');
  await expect(session().getByRole('textbox', { name: '会话消息', exact: true })).toHaveValue('空间未发送草稿');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('侧栏：隐藏和临时展开使网页让位，按钮路径可固定恢复', async () => {
  await page.getByRole('button', { name: '收起 Workshop', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  const edge = page.getByRole('button', { name: '展开 Workshop', exact: true });
  await edge.click();
  await expect(page.getByRole('navigation', { name: '空间标签' })).toBeVisible();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  await expect(page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '取消固定 Workshop', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '空间标签' })).toHaveCount(0);
  await edge.click();
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(false);
  await expect(page.getByRole('complementary', { name: 'Workshop（临时展开）' })).toBeVisible();
  await page.getByRole('button', { name: '固定 Workshop', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
});

test('菜单快捷键：应用菜单⌘B与⌘L仍走明确导航路径', async () => {
  const menus: unknown[] = [];
  await page.evaluate(() => {
    const rows: unknown[] = [];
    let dropped = 0;
    const append = (entry: unknown) => {
      if (rows.length < 100) rows.push(entry);
      else dropped++;
    };
    const focused = () => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, hasFocus: document.hasFocus() });
    const record = (event: Event) =>
      append({
        time: Date.now(),
        type: event.type,
        target: event.target instanceof Element ? event.target.id || event.target.tagName : 'window',
        focus: focused(),
      });
    const unsubscribe = window.studio.shell.onCommand((event) =>
      append({ time: Date.now(), type: 'shell-command', event, focus: focused() }),
    );
    window.addEventListener('focusin', record, true);
    window.addEventListener('blur', record, true);
    (window as unknown as { __cmdLAudit: unknown }).__cmdLAudit = {
      rows,
      dropped: () => dropped,
      cleanup: () => {
        unsubscribe();
        window.removeEventListener('focusin', record, true);
        window.removeEventListener('blur', record, true);
      },
    };
  });
  const failures: unknown[] = [];
  try {
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
    const clickMenu = async (label: string) => {
      const result = await app.evaluate(({ Menu, BrowserWindow }, target) => {
        const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
          for (const item of items) {
            if (item.label === target) return item;
            const nested = item.submenu ? find(item.submenu.items) : undefined;
            if (nested) return nested;
          }
          return undefined;
        };
        const item = find(Menu.getApplicationMenu()?.items ?? []);
        if (!item) throw new Error(`missing menu ${target}`);
        const owner = BrowserWindow.getAllWindows()[0];
        const focus = {
          time: Date.now(),
          label: target,
          focusedWindow: BrowserWindow.getFocusedWindow()?.id,
          owner: owner?.id,
          ownerFocused: owner?.isFocused(),
        };
        item.click(undefined, owner, undefined as never);
        return { accelerator: item.accelerator, focus };
      }, label);
      menus.push(result.focus);
      return result.accelerator;
    };
    expect(await clickMenu('编辑地址')).toBe('CmdOrCtrl+L');
    await expect(page.getByLabel('页面地址')).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await clickMenu('显示或隐藏 Workshop')).toBe('CmdOrCtrl+B');
  } catch (error) {
    failures.push(error);
  }
  try {
    const renderer = await page.evaluate(() => {
      const root = window as unknown as { __cmdLAudit?: { rows: unknown[]; dropped: () => number; cleanup: () => void } };
      const audit = root.__cmdLAudit;
      if (!audit) throw new Error('missing CmdL audit');
      try {
        return { rows: audit.rows, dropped: audit.dropped() };
      } finally {
        audit.cleanup();
        delete root.__cmdLAudit;
      }
    });
    await writeFile(test.info().outputPath('cmdl-audit.json'), JSON.stringify({ menus, renderer }, null, 2));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join('; '));
});

test('窄窗口：活动窗格保留原生bounds，扩大恢复多窗格', async () => {
  const original = (await workspaceSnapshot(page)).workspaces[0]!.layout;
  if (!(await page.getByRole('navigation', { name: '空间标签' }).isVisible()))
    await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  await setWindowSize(app, 900, 700);
  await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1);
  await expect.poll(async () => (await previewInfo(app)).visible).toBe(true);
  await expect
    .poll(async () => {
      const info = await previewInfo(app),
        host = await page.locator('.preview-host:visible').boundingBox();
      return host ? Math.max(...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(info.bounds[key] - host[key]))) : Infinity;
    })
    .toBeLessThanOrEqual(1);
  expect((await previewInfo(app)).bounds.width).toBeGreaterThan(600);
  await setWindowSize(app, 1440, 900);
  await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2);
  expect((await workspaceSnapshot(page)).workspaces[0]!.layout).toEqual(original);
});
