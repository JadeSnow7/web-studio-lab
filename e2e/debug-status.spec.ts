import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DebugStatusSnapshotSchema, StatusTransitionSchema } from '../packages/protocol/src';
import {
  appMenuHas,
  clickAppMenu,
  launchApp,
  previewClick,
  previewElementCenter,
  screensDir,
  setWindowSize,
  setWorkspaceTheme,
  shot,
  target,
} from './helpers';

/*
 * 诊断通道（docs/design/2026-10-11-status-surface/plan.md §2 P3 启用矩阵）：
 * build 产物默认关闭；WSL_DEBUG_STATUS=1 开启；packaged 两行只写不在本机运行。
 * 开发服务器的启用判定由 main/debug-status.test.ts 覆盖。
 */

const sbxBin = path.resolve('e2e/fixtures/sbx.mjs');
const SIX_KEYS = ['setup', 'workbench', 'chat', 'app', 'execution', 'shell'];

const studioKeys = (page: Page) => page.evaluate(() => Object.keys(window.studio));
const debugSnapshot = (page: Page) => page.evaluate(() => window.studio.debug!.status());
/** ipcMain 是否已有 debug:status 的 handler：再注册一次，已有则 Electron 抛错；没有则注册成功并立即撤销。 */
const hasDebugHandler = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    try {
      ipcMain.handle('debug:status', () => null);
    } catch {
      return true;
    }
    ipcMain.removeHandler('debug:status');
    return false;
  });

async function connectTerminal(page: Page) {
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
  const panel = page.getByRole('region', { name: '资源终端' });
  await panel.getByRole('button', { name: '连接终端', exact: true }).click();
  await expect(panel).toContainText('已连接');
}

test.describe('build 产物', () => {
  test.skip(target === 'packaged', 'packaged 的矩阵行见文件末尾');

  test('默认关闭：studio 恰 6 键、菜单无「诊断」、debug:status 未注册、转换与菜单快捷键都不存在', async () => {
    const { app, page } = await launchApp();
    try {
      expect(await studioKeys(page)).toEqual(SIX_KEYS);
      expect(await page.evaluate(() => window.studio.debug)).toBeUndefined();
      expect(await appMenuHas(app, '诊断')).toBe(false);
      expect(await hasDebugHandler(app)).toBe(false);
      await expect(page.getByRole('dialog', { name: '诊断', exact: true })).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('WSL_DEBUG_STATUS=1：studio.debug 存在、快照结构合法、终端连接出现转换、复制 JSON 与 NDJSON 不含会话现场，⇧⌥⌘D 面板 Esc 关闭回焦', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wsl-debug-status-'));
    const log = path.join(dir, 'status.ndjson');
    const { app, page } = await launchApp({ sbxBin, debugStatus: true, statusLog: log });
    try {
      await setWindowSize(app, 1440, 900);
      expect(await studioKeys(page)).toEqual([...SIX_KEYS, 'debug']);
      expect(await appMenuHas(app, '诊断')).toBe(true);
      expect(await hasDebugHandler(app)).toBe(true);

      // invoke 结构合法，且启动时已有环境事实（固定的执行状态是 capability，不是故障）。
      const initial = DebugStatusSnapshotSchema.parse(await debugSnapshot(page));
      expect(initial.facts.find((fact) => fact.key === 'execution:global:state')).toMatchObject({ kind: 'capability' });
      expect(initial.appInstanceId).not.toBe('unavailable');

      // 实时事件：先订阅，再连接终端。
      await page.evaluate(() => {
        const received: unknown[] = [];
        (window as Window & { __transitions?: unknown[] }).__transitions = received;
        window.studio.debug!.onTransition((transition) => received.push(transition));
      });
      await connectTerminal(page);
      await expect
        .poll(
          async () =>
            (await debugSnapshot(page)).transitions.filter(
              (t) => t.key.startsWith('terminal:') && t.key.endsWith(':state') && t.to?.label === '已连接',
            ).length,
        )
        .toBeGreaterThan(0);
      const live = await page.evaluate(() => (window as Window & { __transitions?: unknown[] }).__transitions ?? []);
      const connected = live.map((item) => StatusTransitionSchema.parse(item)).filter((t) => t.to?.label === '已连接');
      expect(connected.length).toBeGreaterThan(0);

      // 产生一份会话现场（PageCapture），用于证明它不进入复制 JSON 与日志。
      const session = page.getByRole('region', { name: 'Agent 会话内容' });
      await page.getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
      await page.getByRole('button', { name: '选择元素', exact: true }).click();
      await page.getByRole('button', { name: '左右分屏', exact: true }).click();
      await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
      await session.getByRole('button', { name: '任务', exact: true }).click();
      await session.getByLabel('附加目标（明确选择）').selectOption({ label: 'TaskFlow 预览' });
      await session.getByRole('button', { name: '采集目标元素' }).click();
      await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
      await previewClick(app, await previewElementCenter(app, '[data-testid="due-1"]'));
      await expect(session).toContainText('现场适用性：有效');
      // 产品界面不再带「诊断详情」。
      await expect(session.getByText('诊断详情')).toHaveCount(0);

      // ⇧⌥⌘D（菜单项的快捷键；⌥⌘D 是 macOS 系统的显示 / 隐藏 Dock）打开面板；焦点先放在一个已知控件上，Esc 关闭后应回到它。
      const trigger = page.getByRole('button', { name: '切换空间', exact: true });
      await trigger.focus();
      await expect(trigger).toBeFocused();
      expect(await clickAppMenu(app, '诊断')).toBe('CmdOrCtrl+Alt+Shift+D');
      const panel = page.getByRole('dialog', { name: '诊断', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('region', { name: '事实' })).toContainText('terminal:');
      await expect(panel.getByRole('region', { name: '事实' })).toContainText('capability');

      // 过滤：只看 terminal domain。
      await panel.getByLabel('domain').selectOption('terminal');
      const rows = panel.locator('[data-status-key]');
      await expect(rows.first()).toBeVisible();
      for (const key of await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status-key')!)))
        expect(key.startsWith('terminal:')).toBe(true);
      await panel.getByLabel('domain').selectOption('all');

      // 会话现场：面板内可查看，并标注不可导出。
      const liveSession = panel.getByRole('region', { name: '当前会话现场（不可导出）' });
      await expect(liveSession).toContainText('不可导出');
      await liveSession.getByRole('button', { name: '查看', exact: true }).click();
      await expect(liveSession.getByLabel('会话现场 JSON（不可导出）')).toContainText('webContentsId');

      // 复制 JSON：来自 Main 的脱敏结果，不含 PageCapture 与截图。
      await app.evaluate(({ clipboard }) => clipboard.writeText(''));
      await panel.getByRole('button', { name: '复制 JSON（已脱敏）' }).click();
      await expect(panel.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      const copiedSnapshot = DebugStatusSnapshotSchema.parse(JSON.parse(copied));
      expect(copiedSnapshot.facts.some((fact) => fact.key.startsWith('terminal:'))).toBe(true);
      for (const forbidden of ['data:image', 'webContentsId', 'screenshot', 'captureId', '未设置', 'workspaces'])
        expect(copied, forbidden).not.toContain(forbidden);

      // Esc 关闭并恢复焦点。
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();

      // NDJSON：首行 snapshot（只含事实），其后为 transition；不含会话现场。
      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(first['type']).toBe('snapshot');
      expect(Object.keys(first).sort()).toEqual(['appInstanceId', 'facts', 'generatedAt', 'seq', 'type']);
      const transitions = lines.slice(1).map((line) => JSON.parse(line) as { type: string; key: string; to: { label: string } | null });
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions.every((line) => line.type === 'transition')).toBe(true);
      expect(transitions.some((line) => line.key.startsWith('terminal:') && line.to?.label === '已连接')).toBe(true);
      for (const forbidden of ['data:image', 'webContentsId', 'screenshot', 'captureId'])
        expect(lines.join('\n'), forbidden).not.toContain(forbidden);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('诊断面板截图：白 / 暗 / 暖主题 × 1440', async () => {
    const { app, page } = await launchApp({ sbxBin, debugStatus: true });
    try {
      await mkdir(path.join(screensDir, 'status-surface'), { recursive: true });
      await setWindowSize(app, 1440, 900);
      await connectTerminal(page);
      for (const theme of ['light', 'dark', 'warm']) {
        await setWorkspaceTheme(page, theme);
        await clickAppMenu(app, '诊断');
        const panel = page.getByRole('dialog', { name: '诊断', exact: true });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('region', { name: '事实' })).toContainText('terminal:');
        await shot(page, `status-surface/debug-panel-${theme}-1440`);
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      }
    } finally {
      await app.close();
    }
  });
});

/* packaged 两行（plan §2 P3）：本机不运行，`WSL_E2E_TARGET=packaged` 时执行。helper 会清除所有 WSL_*，debugStatus 在清除之后再写入。 */

test('packaged 默认关闭：studio 恰 6 键、菜单无「诊断」、debug:status 未注册', async () => {
  test.skip(target !== 'packaged', '仅 packaged 目标');
  const { app, page } = await launchApp();
  try {
    expect(await studioKeys(page)).toEqual(SIX_KEYS);
    expect(await appMenuHas(app, '诊断')).toBe(false);
    expect(await hasDebugHandler(app)).toBe(false);
  } finally {
    await app.close();
  }
});

test('packaged 显式启用（WSL_DEBUG_STATUS=1）：studio.debug 存在、菜单有「诊断」、快照结构合法', async () => {
  test.skip(target !== 'packaged', '仅 packaged 目标');
  const { app, page } = await launchApp({ debugStatus: true });
  try {
    expect(await studioKeys(page)).toEqual([...SIX_KEYS, 'debug']);
    expect(await appMenuHas(app, '诊断')).toBe(true);
    expect(await hasDebugHandler(app)).toBe(true);
    expect(DebugStatusSnapshotSchema.safeParse(await debugSnapshot(page)).success).toBe(true);
  } finally {
    await app.close();
  }
});
