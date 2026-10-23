import { randomUUID } from 'node:crypto';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorkbenchCommand } from '../packages/protocol/src';
import { launchApp, workshopNavigate, workspaceSnapshot } from './helpers';

// W4b：逐项审批。fixture sbx 把 `claude-agent-acp` 换成假 ACP Agent 的 `ask` 场景：它申请一个 fetch 权限，
// 选项含“始终允许”；执行核心只展示一次性选项。不运行 guest 与模型。
let app: ElectronApplication, page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  ({ app, page } = await launchApp({ sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname, fixtureAcpScenario: 'ask' }));
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.studio.chat.getStatus())).harnesses.find((h) => h.descriptor.harnessId === 'claude-code')
          ?.available,
    )
    .toBe(true);
  await page.evaluate(() => window.studio.chat.profiles.setDefault({ harnessId: 'claude-code', profileId: 'claude-code:default' }));
});
test.afterAll(async () => {
  await app?.close();
});
const TITLE = '获取 https://example.invalid/data';

test('个人对话：fetch 权限交给用户，只显示一次性选项；允许与拒绝分别送达 Agent 并记入会话', async () => {
  await workshopNavigate(page, '首页');
  const region = page.getByRole('region', { name: '混合输入' });
  const send = async (text: string) => {
    await region.getByRole('textbox').fill(text);
    await region.getByRole('button', { name: '发送', exact: true }).click({ force: true });
  };
  const card = region.getByRole('group', { name: '待决定的权限请求' });

  await send('取数据一');
  await expect(card).toContainText(TITLE);
  await expect(card).toContainText('fetch');
  await expect(card.getByRole('button')).toHaveText(['允许一次', '拒绝']);
  await card.getByRole('button', { name: '允许一次' }).click();
  await expect(region.locator('.message-agent').last()).toHaveText(/决定：yes/);
  await expect(card).toHaveCount(0);

  await send('取数据二');
  await card.getByRole('button', { name: '拒绝' }).click();
  await expect(region.locator('.message-agent').last()).toHaveText(/决定：no/);
  const conversation = await page.evaluate(() => window.studio.chat.get('conv-personal-default'));
  expect(conversation.warnings).toEqual(expect.arrayContaining([`已允许 ${TITLE}（用户，一次）`, `已拒绝 ${TITLE} 的权限请求（用户）`]));
  expect(conversation.permissionRequests ?? []).toEqual([]);
});

test('空间会话：执行中的请求显示在会话里，允许后执行完成；执行记录冻结 Claude Code', async () => {
  const command = (input: Omit<WorkbenchCommand, 'commandId' | 'workspaceId'> & Record<string, unknown>) =>
    page.evaluate((payload) => window.studio.workbench.command(payload as never), {
      ...input,
      workspaceId: 'taskflow-demo',
      commandId: randomUUID(),
    });
  const snapshot = await workspaceSnapshot(page);
  const sessionId = snapshot.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.sessions[0]!.sessionId;
  const confirmed = await command({ type: 'confirmTask', sessionId, goal: 'W4b 审批', targetRef: null });
  expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
  const version = confirmed.snapshot.workspaces
    .find((w) => w.workspaceId === 'taskflow-demo')!
    .sessions.find((s) => s.sessionId === sessionId)!
    .taskVersions.at(-1)!;
  const started = await command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId });
  expect(started.ok, JSON.stringify(started)).toBe(true);

  await workshopNavigate(page, '空间');
  await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
  const card = page.getByRole('region', { name: 'Agent 会话内容' }).getByRole('group', { name: '待决定的权限请求' });
  await expect(card).toContainText(TITLE);
  await card.getByRole('button', { name: '允许一次' }).click();
  const latest = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.runs.at(-1)!;
  await expect.poll(async () => (await latest()).state, { timeout: 15000 }).toBe('completed');
  const run = await latest();
  expect(run.harness).toMatchObject({ harnessId: 'claude-code', adapter: 'acp', profileId: 'claude-code:default' });
  expect(run.conversation?.messages.at(-1)?.text).toBe('决定：yes');
  expect(run.conversation?.warnings).toContain(`已允许 ${TITLE}（用户，一次）`);
  await expect(card).toHaveCount(0);
});
