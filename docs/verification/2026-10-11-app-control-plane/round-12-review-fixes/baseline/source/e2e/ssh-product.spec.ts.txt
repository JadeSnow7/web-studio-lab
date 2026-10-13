import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { launchApp, workspaceSnapshot, setWindowSize } from './helpers';
import { writeFile } from 'node:fs/promises';
import { sshLoopback } from './fixtures/ssh-loopback';
import type { WorkbenchResource } from '../packages/protocol/src';

test.setTimeout(180000);
async function create(page: Page, kind: 'file' | 'ssh', title: string) {
  await page.getByRole('button', { name: '新建标签', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建标签' });
  await editor.getByLabel('标签类型').selectOption(kind);
  await editor.getByLabel('名称', { exact: true }).fill(title);
  await editor.getByLabel('资源环境').selectOption('ssh');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
}
async function resource(page: Page, title: string): Promise<WorkbenchResource> {
  const snapshot = await workspaceSnapshot(page);
  return snapshot.workspaces.find((w) => w.workspaceId === snapshot.activeWorkspaceId)!.resources.find((r) => r.title === title)!;
}

async function fileRequest(page: Page, action: () => Promise<unknown>) {
  const before = (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)?.request.requestId;
  await action();
  await expect
    .poll(async () => {
      const record = (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1);
      return record?.request.requestId !== before && record?.state !== 'pending' && !!record?.result;
    })
    .toBe(true);
  return (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)!;
}

async function attachEvidence(info: TestInfo, name: string, value: unknown) {
  const file = info.outputPath(`${name}.json`);
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
  await info.attach(name, { path: file, contentType: 'application/json' });
}

test('产品SSH_AUTH_SOCK认证、SFTP范围/续读/搜索与真实PTY同实例观察/重开/停止', async ({ playwright: _playwright }, info) => {
  const fixture = await sshLoopback();
  let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  let originalFailure: unknown;
  const failures: unknown[] = [];
  let cleanupUnknown = false;
  try {
    const launched = await launchApp({ sshEnvironment: fixture.environment, userData: fixture.profile });
    app = launched.app;
    const page = launched.page;
    await create(page, 'file', '回环SSH文件');
    const files = page.getByRole('region', { name: '只读文件浏览' });
    await files.getByRole('button', { name: '列出目录', exact: true }).click();
    await files.getByRole('button', { name: '中文.txt · file', exact: true }).click();
    const current = files.getByRole('region', { name: '当前文件结果' });
    await expect(current).toContainText(fixture.nonce);
    await expect(current).toContainText('远端文件');
    const file = await resource(page, '回环SSH文件');
    const first = (await workspaceSnapshot(page)).workspaces[0]!.observations.at(-1)!;
    expect(first.request.sessionId).toBeNull();
    expect(first.request.runId).toBeNull();
    expect(first.request.target).toMatchObject({
      environmentId: 'ssh',
      resourceId: file.resourceId,
      instanceId: file.instanceId,
      instanceGeneration: file.generation,
    });
    expect(first.result).toMatchObject({ source: 'sftp', resource: first.request.target });
    await files.getByLabel('文件路径').fill('large.txt');
    const large = await fileRequest(page, () => files.getByRole('button', { name: '读取文件', exact: true }).click());
    await expect(files.getByRole('button', { name: '继续读取', exact: true })).toBeVisible();
    const continuation = await fileRequest(page, () => files.getByRole('button', { name: '继续读取', exact: true }).click());
    if (!large.result || !('resource' in large.result) || !continuation.result || !('resource' in continuation.result))
      throw new Error('Expected successful SFTP pages');
    expect(continuation.result).toMatchObject({ source: 'sftp', revision: large.result.revision });
    expect((continuation.result.coverage.range as { startByte: number }).startByte).toBeGreaterThan(0);
    await files.getByLabel('文件路径').fill('.');
    await files.getByLabel('文件搜索').fill(fixture.nonce);
    await files.getByRole('button', { name: '搜索文件', exact: true }).click();
    await expect(files.getByRole('list', { name: '文件搜索结果' })).toContainText('中文.txt');
    for (const path of ['../outside.txt', 'escape.txt']) {
      await files.getByLabel('文件路径').fill(path);
      const denied = await fileRequest(page, () => files.getByRole('button', { name: '读取文件', exact: true }).click());
      await expect(current).toContainText('未获授权');
      expect(denied.request.args).toMatchObject({ path });
      expect(denied.result).toMatchObject({ error: 'unauthorized' });
    }
    await create(page, 'ssh', '回环真PTY');
    const terminal = page.getByRole('region', { name: '资源终端' });
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(terminal).toContainText('已连接');
    expect(fixture.evidence.signedAuthentications).toBeGreaterThan(0);
    await setWindowSize(app, 1300, 800);
    await expect.poll(() => fixture.evidence.resize.length).toBeGreaterThan(0);
    const connected = await resource(page, '回环真PTY');
    const input = terminal.getByLabel('终端输入');
    await input.pressSequentially(`stty -echo; tty; stty size; printf '\\344\\270\\255\\346\\226\\207_${fixture.nonce}\\n'`);
    await input.press('Enter');
    await expect
      .poll(async () => (await resource(page, '回环真PTY')).terminal?.output.replace(/\r/g, ''))
      .toMatch(new RegExp(`(?:^|\\n)中文_${fixture.nonce}(?:\\n|$)`));
    expect((await resource(page, '回环真PTY')).terminal!.output).toMatch(/\/dev\/(?:ttys\w+|pts\/\d+)/);
    const size = fixture.evidence.resize.at(-1);
    expect(size).toBeDefined();
    expect((await resource(page, '回环真PTY')).terminal!.output).toContain(`${size!.rows} ${size!.cols}`);
    await page.getByRole('button', { name: '回环真PTY操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '关闭标签（保留后台执行）' }).click();
    await page.getByText('后台资源 / 已关闭标签', { exact: true }).click();
    await page.getByRole('button', { name: '回环真PTY · 重新打开', exact: true }).click();
    const reopened = await resource(page, '回环真PTY');
    expect(reopened.instanceId).toBe(connected.instanceId);
    expect(reopened.terminal!.sessionId).toBe(connected.terminal!.sessionId);
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: 'Agent 会话', exact: true }).click();
    const session = page.getByRole('region', { name: 'Agent 会话内容' });
    await session.getByRole('button', { name: '上下文', exact: true }).click();
    const observe = session.getByRole('region', { name: '会话统一观察' });
    await observe.getByLabel('观察来源').selectOption(connected.resourceId);
    await observe.getByLabel('读取动作').selectOption('terminal.read_output');
    await observe.getByRole('button', { name: '读取观察', exact: true }).click();
    await expect(observe.getByRole('region', { name: '当前观察结果' })).toContainText(fixture.nonce);
    const w = (await workspaceSnapshot(page)).workspaces[0]!;
    const observation = w.sessions[0]!.observations.at(-1)!;
    expect(observation.request.target).toMatchObject({
      environmentId: 'ssh',
      resourceId: connected.resourceId,
      instanceId: connected.instanceId,
      instanceGeneration: connected.generation,
    });
    expect(observation.result).toMatchObject({ resource: observation.request.target, source: 'terminal_output' });
    await attachEvidence(info, 'main-observation-records', {
      fileRead: first,
      firstPage: large,
      nextPage: continuation,
      fileHistory: w.observations,
      sessionTerminal: observation,
    });
    await page.getByRole('navigation', { name: '空间标签' }).getByRole('button', { name: '回环真PTY', exact: true }).click();
    await terminal.getByRole('button', { name: '关闭终端', exact: true }).click();
    await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.state).toBe('closed');
    await expect.poll(() => fixture.evidence.ptysCleaned).toBe(1);
    expect((await resource(page, '回环真PTY')).terminal!.cleanupPending).toBe(false);
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.state).toBe('running');
    const next = await resource(page, '回环真PTY');
    expect(next.instanceId).not.toBe(connected.instanceId);
    expect(next.generation).toBeGreaterThan(connected.generation);
    expect(next.terminal!.sessionId).not.toBe(connected.terminal!.sessionId);
    fixture.disconnect();
    await expect.poll(async () => (await resource(page, '回环真PTY')).terminal?.state).toBe('failed');
    expect((await resource(page, '回环真PTY')).terminal!.cleanupPending).toBe(true);
    cleanupUnknown = true;
    await expect.poll(() => fixture.evidence.ptysCleaned).toBe(2);
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect(page.locator('.workspace-error')).toContainText('清理未确认');
    expect(fixture.evidence.ptysStarted).toBe(2);
  } catch (error) {
    originalFailure = error;
  } finally {
    try {
      if (cleanupUnknown && app && app.process().exitCode === null) {
        await attachEvidence(info, 'unknown-close-boundary', {
          cleanupUnknown: true,
          normalAppShutdownAccepted: false,
          forcedOwnedPid: app.process().pid,
          reason:
            'Product deliberately refuses normal window close with unknown remote cleanup; fixture independently confirmed owned PTYs exited',
        });
        const exited = new Promise<void>((resolve) => app!.process().once('exit', () => resolve()));
        app.process().kill('SIGKILL');
        await exited;
      }
      await app?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.stop();
    } catch (error) {
      failures.push(error);
    }
    await attachEvidence(info, 'owned-ssh-evidence', fixture.evidence);
  }
  if (failures.length)
    throw new AggregateError(
      [...(originalFailure !== undefined ? [originalFailure] : []), ...failures],
      'Product SSH scenario and cleanup failed',
      { cause: originalFailure ?? failures[0] },
    );
  if (originalFailure !== undefined) throw originalFailure;
});

test('产品错误host pin在认证前拒绝，不启动PTY', async ({ playwright: _playwright }, info) => {
  const fixture = await sshLoopback();
  let app: Awaited<ReturnType<typeof launchApp>>['app'] | undefined;
  let originalFailure: unknown;
  const failures: unknown[] = [];
  try {
    const launched = await launchApp({
      sshEnvironment: { ...fixture.environment, hostKeySha256: '0'.repeat(64) },
      userData: fixture.profile,
    });
    app = launched.app;
    const page = launched.page;
    await create(page, 'ssh', '错误pin');
    const terminal = page.getByRole('region', { name: '资源终端' });
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect.poll(async () => (await resource(page, '错误pin')).terminal?.state).toBe('failed');
    expect(fixture.evidence.authentications).toBe(0);
    expect(fixture.evidence.ptysStarted).toBe(0);
    expect((await resource(page, '错误pin')).terminal!.cleanupPending).toBe(false);
    const first = await resource(page, '错误pin');
    await terminal.getByRole('button', { name: '连接终端', exact: true }).click();
    await expect
      .poll(async () => {
        const next = await resource(page, '错误pin');
        return next.instanceId !== first.instanceId && next.terminal?.state === 'failed';
      })
      .toBe(true);
    expect((await resource(page, '错误pin')).generation).toBeGreaterThan(first.generation);
    expect(fixture.evidence.connections).toBeGreaterThanOrEqual(2);
    expect(fixture.evidence.authentications).toBe(0);
    expect(fixture.evidence.ptysStarted).toBe(0);
  } catch (error) {
    originalFailure = error;
  } finally {
    try {
      await app?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await fixture.stop();
    } catch (error) {
      failures.push(error);
    }
    await attachEvidence(info, 'owned-ssh-evidence', fixture.evidence);
  }
  if (failures.length)
    throw new AggregateError(
      [...(originalFailure !== undefined ? [originalFailure] : []), ...failures],
      'Bad-pin scenario and cleanup failed',
      { cause: originalFailure ?? failures[0] },
    );
  if (originalFailure !== undefined) throw originalFailure;
});
