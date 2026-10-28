import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorkbenchCommand } from '../packages/protocol/src';
import { launchApp, workshopNavigate, workspaceSnapshot } from './helpers';

// W4a：设置页的 Harness 与 Profile、会话内的选择与 startRun 冻结。fixture sbx 不运行 guest 与模型；
// fixture 中 Claude Code 的 ACP 包装器不存在，因此 Claude Code 不可用，其 Profile 的自检仍走 fixture 的 `auth status`。
let app: ElectronApplication, page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname }));
});
test.afterAll(async () => {
  await app?.close();
});
const command = (input: Omit<WorkbenchCommand, 'commandId' | 'workspaceId'> & Record<string, unknown>) =>
  page.evaluate((payload) => window.studio.workbench.command(payload as never), {
    ...input,
    workspaceId: 'taskflow-demo',
    commandId: randomUUID(),
  });

test('设置页：Harness 可用性、内置 Profile 自检、新建 Profile 自检，界面与文件都不含账号信息', async () => {
  await workshopNavigate(page, '设置');
  const harnesses = page.getByRole('table', { name: 'Harness 可用性' });
  await expect(harnesses.getByRole('row').filter({ hasText: 'Codex CLI' })).toContainText('可用');
  await expect(harnesses.getByRole('row').filter({ hasText: 'Claude Code' })).toContainText('Claude Code 不可用');
  const list = page.getByRole('table', { name: 'Profile 列表' });
  const codex = list.locator('[data-profile-id="codex:default"]');
  await expect(codex).toContainText('sbx 默认');
  await expect(codex).toContainText('· 默认');
  // 执行服务可用后为每个 Profile 自检一次。
  await expect(codex).toContainText('已登录');
  await expect(list.locator('[data-profile-id="claude-code:default"]')).toContainText('已登录');

  await page.getByPlaceholder('标签，例如：工作账号').fill('工作账号');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  const created = list.getByRole('row').filter({ hasText: '工作账号' });
  await expect(created).toContainText('/home/agent/.wsl-profiles/claude-code/');
  await expect(created).toContainText('已登录');
  await expect(created).toContainText('CLAUDE_CONFIG_DIR=/home/agent/.wsl-profiles/claude-code/');
  await expect(page.locator('body')).not.toContainText('fixture@example.invalid');
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'));
  const saved = await readFile(path.join(userData, 'harness-profiles.json'), 'utf8');
  expect(saved).toContain('工作账号');
  expect(saved).not.toContain('fixture@example.invalid');
  expect(saved).not.toContain('claude.ai');
});

test('会话选择：所选 Harness 不可用时执行照常创建并以其原因失败，出处冻结所选 Profile；跟随默认时冻结 Codex 内置 Profile', async () => {
  const snapshot = await workspaceSnapshot(page);
  const space = snapshot.workspaces.find((workspace) => workspace.workspaceId === 'taskflow-demo')!;
  const sessionId = space.sessions[0]!.sessionId;
  const confirm = async (goal: string) => {
    const result = await command({ type: 'confirmTask', sessionId, goal, targetRef: null });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.snapshot.workspaces
      .find((w) => w.workspaceId === 'taskflow-demo')!
      .sessions.find((s) => s.sessionId === sessionId)!
      .taskVersions.at(-1)!;
  };

  const selected = await command({
    type: 'setSessionHarness',
    sessionId,
    selection: { harnessId: 'claude-code', profileId: 'claude-code:default' },
  });
  expect(selected.ok).toBe(true);
  // 与“执行器不可用时记录失败运行”的既有约定一致：执行被创建，在启动路径上以 Harness 的原因失败，不换用其他 Harness。
  const unavailable = await command({
    type: 'startRun',
    sessionId,
    taskVersionId: (await confirm('W4a 选择不可用 Harness')).taskVersionId,
  });
  expect(unavailable.ok, JSON.stringify(unavailable)).toBe(true);
  const latest = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.runs.at(-1)!;
  await expect.poll(async () => (await latest()).state, { timeout: 15000 }).toBe('failed');
  expect(await latest()).toMatchObject({
    error: expect.stringContaining('Claude Code 不可用'),
    cleanupPending: false,
    harness: { harnessId: 'claude-code', profileId: 'claude-code:default' },
  });

  expect((await command({ type: 'setSessionHarness', sessionId, selection: null })).ok).toBe(true);
  const started = await command({ type: 'startRun', sessionId, taskVersionId: (await confirm('W4a 跟随默认')).taskVersionId });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const run = started.snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.runs.at(-1)!;
  expect(run.harness).toMatchObject({ harnessId: 'codex', displayName: 'Codex CLI', adapter: 'native', profileId: 'codex:default' });
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.runs.at(-1)!.state, {
      timeout: 15000,
    })
    .not.toMatch(/^(starting|running|cancelling)$/);
});
