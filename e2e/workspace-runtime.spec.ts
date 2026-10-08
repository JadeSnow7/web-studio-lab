import { setWorkspaceTheme } from './helpers';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, terminalSnapshot, workspaceSnapshot, screensDir } from './helpers';

async function newSpace(page: Page, name: string) {
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  const switcher = page.getByRole('dialog', { name: '切换空间' });
  await expect(switcher).toBeVisible();
  await switcher.getByRole('button', { name: '新建空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建空间' });
  await dialog.getByLabel('名称').fill(name);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function selectSpace(page: Page, name: string) {
  await page.getByRole('button', { name: '切换空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '切换空间' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: new RegExp(`${name}.*个标签`) }).click();
}

test('A06 / A07 fixture执行中关闭标签后重新打开仍是同一运行，重复发送不启动两次', async () => {
  const { app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname });
  try {
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const region = page.getByRole('region', { name: 'Agent 会话内容' });
    await region.getByRole('textbox').fill('[slow]');
    await region.getByRole('button', { name: '发送', exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).click();
      (node as HTMLButtonElement).click();
    });
    await expect(region.getByRole('button', { name: '取消回复' })).toBeVisible();
    let snapshot = await workspaceSnapshot(page);
    const owner = snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!,
      run = owner.runs.at(-1)!,
      sessionId = run.sessionId;
    expect(owner.runs).toHaveLength(1);
    expect(owner.sessions.find((s) => s.sessionId === sessionId)?.taskVersions).toHaveLength(1);
    await page.getByRole('button', { name: 'Agent 会话操作' }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）' }).click();
    await expect(region).toHaveCount(0);
    await page.getByText('后台资源 / 已关闭标签').click();
    await page.getByRole('button', { name: 'Agent 会话 · 重新打开' }).click();
    await expect(region.getByRole('button', { name: '取消回复' })).toBeVisible();
    snapshot = await workspaceSnapshot(page);
    expect(snapshot.workspaces[0]!.runs.at(-1)?.runId).toBe(run.runId);
    expect(snapshot.workspaces[0]!.sessions[0]?.sessionId).toBe(sessionId);
    await region.getByRole('button', { name: '取消回复' }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('cancelled');
  } finally {
    await app.close();
  }
});

test('live：真实PTY与单Agent执行跨空间保持归属，检查和审阅独立', async () => {
  test.skip(process.env['WSL_LIVE_WORKSPACE'] !== '1', '真实sbx与模型仅在本轮明确启用WSL_LIVE_WORKSPACE=1执行');
  test.setTimeout(240000);
  const { app, page, rendererErrors } = await launchApp({ live: true });
  const marker = randomUUID();
  try {
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    const terminal = page.getByRole('region', { name: '沙箱终端' });
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(terminal).toContainText('已连接', { timeout: 30000 });
    const initial = await terminalSnapshot(page);
    const input = terminal.getByLabel('沙箱终端输入');
    await input.focus();
    await input.pressSequentially(`printf 'WSL_RUNTIME_NONCE=%s\\n' '${marker}'`);
    await input.press('Enter');
    await expect
      .poll(async () => stripVTControlCharacters((await terminalSnapshot(page)).output).replace(/\r/g, ''), { timeout: 30000 })
      .toMatch(new RegExp(`^WSL_RUNTIME_NONCE=${marker}$`, 'm'));
    await page.getByRole('button', { name: '左右分屏', exact: true }).click();
    await page.getByRole('button', { name: '关闭窗格', exact: true }).first().click();
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    expect((await terminalSnapshot(page)).sessionId).toBe(initial.sessionId);
    await newSpace(page, '运行归属验证');
    await selectSpace(page, 'TaskFlow');
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    expect((await terminalSnapshot(page)).sessionId).toBe(initial.sessionId);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('button', { name: '任务', exact: true }).click();
    await session.getByLabel('修改目标').fill(`请只回复校验词 ${marker}。不要运行工具，不要读取、修改或创建任何文件。`);
    await session.getByRole('button', { name: '确认任务（生成新版本）' }).click();
    await expect(session).toContainText('任务 v1');
    await session.getByRole('button', { name: '开始运行' }).click();
    await selectSpace(page, '运行归属验证');
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('运行归属验证');
    await expect
      .poll(async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')?.runs.at(-1)?.state, {
        timeout: 120000,
      })
      .toBe('completed');
    await selectSpace(page, 'TaskFlow');
    await session.getByRole('button', { name: '对话', exact: true }).click();
    await expect(session.getByRole('log')).toContainText(marker);
    const run = (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.runs.at(-1)!;
    expect(run.workspaceId).toBe('taskflow-demo');
    expect(run.validation.state).toBe('not_run');
    expect(run.review).toBeNull();
    await session.getByRole('button', { name: '检查', exact: true }).click();
    await session.getByRole('button', { name: '运行检查' }).click();
    await expect(session).toContainText('检查：blocked');
    await expect(session.getByRole('button', { name: '接受结果' })).toBeDisabled();
    await expect(session).toContainText('审阅：尚未审阅');
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '开发终端', exact: true }).click();
    await terminal.getByRole('button', { name: '关闭终端', exact: true }).click();
    await expect(terminal).toContainText('已关闭，远端进程已退出', { timeout: 30000 });
    expect((await terminalSnapshot(page)).state).toBe('closed');
    expect(rendererErrors, '真实工作台执行期间不能出现 renderer 异常').toEqual([]);
  } finally {
    await mkdir(screensDir, { recursive: true });
    await writeFile(
      path.join(screensDir, 'workspace-live4-evidence.json'),
      JSON.stringify({ marker, rendererErrors, snapshot: await workspaceSnapshot(page) }, null, 2),
    );
    await app.close();
  }
});

test('A11 重启恢复布局与草稿和历史，运行不重放，明确旧模型上下文未恢复', async () => {
  const fixture = new URL('./fixtures/sbx.mjs', import.meta.url).pathname;
  let { app, page } = await launchApp({ sbxBin: fixture });
  const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  let ownerId: string, runId: string, oldEpoch: string;
  try {
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('textbox').fill('重启历史742');
    await session.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs.at(-1)?.state).toBe('completed');
    await session.getByRole('textbox').fill('重启保留草稿');
    await setWorkspaceTheme(page, 'warm');
    await page.getByRole('button', { name: '上下分屏', exact: true }).click();
    await expect(page.locator('[data-pane-id]')).toHaveCount(2);
    const snapshot = await workspaceSnapshot(page);
    ownerId = snapshot.activeWorkspaceId;
    runId = snapshot.workspaces[0]!.runs.at(-1)!.runId;
    oldEpoch = snapshot.appInstanceId;
    await app.close();
    ({ app, page } = await launchApp({ sbxBin: fixture, userData: profile }));
    await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('TaskFlow');
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('textbox')).toHaveValue('重启保留草稿');
    await expect(page.getByText('历史已恢复；新执行不会自动延续旧模型上下文。')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm');
    const restored = await workspaceSnapshot(page);
    expect(restored.appInstanceId).not.toBe(oldEpoch);
    expect(restored.activeWorkspaceId).toBe(ownerId);
    expect(restored.workspaces[0]!.runs).toHaveLength(1);
    expect(restored.workspaces[0]!.runs[0]!.runId).toBe(runId);
    expect(restored.workspaces[0]!.runs[0]!.state).toBe('completed');
    await expect(page.locator('[data-pane-id]')).toHaveCount(2);
  } finally {
    await app.close();
  }
});
