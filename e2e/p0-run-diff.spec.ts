import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { WorkbenchCommandSchema } from '../packages/protocol/src';
import { launchApp, setWindowSize, setWorkspaceTheme, target, workshopNavigate, workspaceSnapshot } from './helpers';

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
  if (value == null) throw new Error('missing source fixture value');
  return value;
};

async function setup() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Source Fixture</title><button style="margin:40px;padding:20px" data-testid="source-button">Before source</button>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server missing port');
  const url = `http://127.0.0.1:${address.port}`;
  const { app, page, rendererErrors } = await launchApp({
    sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname,
    sourceSnapshotFixture: true,
    sourceDispatchAudit: true,
  }).catch(async (error: unknown) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((closeError) => (closeError ? reject(closeError) : resolve())));
    throw error;
  });
  const close = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        app.process().kill('SIGKILL');
        reject(new Error('source fixture Electron cleanup timed out; only this test process was terminated'));
      }, 10000);
    });
    const stopping = (async () => {
      await app
        .evaluate(() => {
          __wslSourceFixture.releaseSnapshots();
          __wslSourceFixture.releasePatches();
        })
        .catch(() => undefined);
      await app.close();
    })();
    try {
      await Promise.race([stopping, timeout]);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
  try {
    await expect.poll(() => page.evaluate(async () => (await window.studio.chat.getStatus()).available)).toBe(true);
    await app.evaluate((_electron, value) => {
      __wslSourceFixture.url = value;
    }, url);
    const command = async (data: Record<string, unknown>) => {
      const input = WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId: 'taskflow-demo', ...data });
      return page.evaluate((command) => window.studio.workbench.command(command), input);
    };
    const created = await command({ type: 'createApp' });
    expect(created.ok, JSON.stringify(created.ok ? null : created.error)).toBe(true);
    const started = await command({ type: 'startApp' });
    expect(started.ok, JSON.stringify(started.ok ? null : started.error)).toBe(true);
    const owner = async () => required((await workspaceSnapshot(page)).workspaces.find((space) => space.workspaceId === 'taskflow-demo'));
    const space = await owner();
    const sessionId = required(space.sessions[0]).sessionId;
    const resource = required(space.resources.find((item) => item.appProjectId));
    await expect.poll(() => app.windows().some((window) => window.url().startsWith(url))).toBe(true);
    const browser = required(app.windows().find((window) => window.url().startsWith(url)));
    await expect(browser.getByTestId('source-button')).toBeVisible();
    expect((await command({ type: 'captureContext', sessionId, resourceId: resource.resourceId, requestId: randomUUID() })).ok).toBe(true);
    await browser.getByTestId('source-button').click();
    await expect.poll(async () => required((await owner()).sessions[0]).captureRequest?.state).toBe('completed');
    // OPS-1 B1：工程与页面引用分别提交（appId、captureId），不再从受管 App 页面推断工程。
    const captured = required((await owner()).sessions[0]);
    expect(
      (
        await command({
          type: 'confirmTask',
          sessionId,
          goal: 'D source fixture task',
          targetRef: { kind: 'web', resourceId: resource.resourceId },
          appId: required(space.app).appId,
          captureId: required(captured.context).captureId,
        })
      ).ok,
    ).toBe(true);
    const taskVersionId = required(required((await owner()).sessions[0]).taskVersions[0]).taskVersionId;
    const start = () => command({ type: 'startRun', sessionId, taskVersionId });
    const run = async () => required((await owner()).runs.at(-1));
    const select = async (runId: string) => {
      await workshopNavigate(page, '任务');
      await page.getByRole('navigation', { name: '任务与运行记录' }).locator(`button[title="${runId}"]`).click();
      await page.getByRole('navigation', { name: '运行视图' }).getByRole('button', { name: 'diff', exact: true }).click();
    };
    return { app, page, rendererErrors, command, owner, sessionId, start, run, select, close };
  } catch (error) {
    await close();
    throw error;
  }
}
const details = (page: Page) => page.getByRole('region', { name: '运行详情', exact: true });

test('D: real host baseline/diff, collecting, cleanup gating, no changes and unavailable in task history', async () => {
  const testInfo = test.info();
  test.skip(target !== 'build', 'deterministic Main/service injection uses the built Electron harness');
  const f = await setup();
  try {
    await f.app.evaluate(() => {
      __wslSourceFixture.holdSnapshots = true;
    });
    const starting = f.start();
    await expect.poll(() => f.app.evaluate(() => __wslSourceFixture.pendingSnapshots.size)).toBe(1);
    const runId = (await f.run()).runId;
    await f.select(runId);
    await expect(details(f.page)).toContainText('正在采集源码基线');
    expect(await f.app.evaluate(() => __wslSourceFixture.sends.length)).toBe(0);
    expect(await f.app.evaluate(() => __wslSourceFixture.patchRequests.length)).toBe(0);
    await f.page.screenshot({ path: testInfo.outputPath('baseline-collecting.png') });
    await f.app.evaluate(() => __wslSourceFixture.releaseSnapshots());
    expect((await starting).ok).toBe(true);
    await expect(details(f.page)).toContainText('源码基线已保存');
    const profile = await f.app.evaluate(({ app }) => app.getPath('userData'));
    const before = await readFile(path.join(profile, 'runs', runId, 'baseline.json'), 'utf8');
    expect(before).toContain(runId);
    expect(await f.app.evaluate(() => __wslSourceDispatchAudit)).toMatchObject({
      truncated: false,
      sends: [{ runId, beforeDispatch: true, error: null, outboundHostDetails: false, baseline: { runId } }],
    });
    const outbound = await f.app.evaluate(() => JSON.stringify([__wslSourceFixture.sends, __wslSourceFixture.sourceRequests]));
    expect(outbound).not.toContain(profile);
    expect(outbound).not.toContain('baseTree');
    await f.app.evaluate((_electron, sessionId) => {
      __wslSourceFixture.content = 'export const label = "after 中文";\n';
      __wslSourceFixture.holdSnapshots = true;
      __wslSourceFixture.finish(sessionId, 'idle', true);
    }, f.sessionId);
    await expect(details(f.page)).toContainText('等待清理确认后采集源码差异');
    expect(await f.app.evaluate(() => __wslSourceFixture.sourceRequests.length)).toBe(1);
    await f.app.evaluate((_electron, sessionId) => __wslSourceFixture.finish(sessionId), f.sessionId);
    await expect.poll(() => f.app.evaluate(() => __wslSourceFixture.pendingSnapshots.size)).toBe(1);
    await expect(details(f.page)).toContainText('正在采集结束源码');
    await f.page.screenshot({ path: testInfo.outputPath('ending-collecting.png') });
    await f.app.evaluate(() => __wslSourceFixture.releaseSnapshots());
    await expect(details(f.page).getByLabel('源码 diff')).toContainText('+export const label = "after 中文";');
    await expect(details(f.page).locator('.diff-del')).toContainText('-export const label = "before";');
    await expect(details(f.page).getByRole('list', { name: '修改文件' })).toContainText('M src/button.ts');
    await details(f.page).getByLabel('源码 diff').focus();
    await expect(details(f.page).getByLabel('源码 diff')).toBeFocused();
    const first = await f.run();
    expect(first.sourceChange?.state).toBe('captured');
    expect(first.validation.state).toBe('not_run');
    expect(first.review).toBeNull();
    const realPatch = await f.page.evaluate((id) => window.studio.workbench.runPatch('taskflow-demo', id), runId);
    expect(createHash('sha256').update(realPatch.patch).digest('hex')).toBe(realPatch.patchSha256);
    expect(await readFile(path.join(profile, 'runs', runId, 'baseline.json'), 'utf8')).toBe(before);
    await f.page.screenshot({ path: testInfo.outputPath('captured-diff.png') });
    expect((await f.start()).ok).toBe(true);
    await f.app.evaluate((_electron, sessionId) => __wslSourceFixture.finish(sessionId), f.sessionId);
    await expect.poll(async () => (await f.run()).sourceChange?.state).toBe('captured');
    await f.select((await f.run()).runId);
    await expect(details(f.page)).toContainText('源码无改动');
    await expect(details(f.page)).toContainText('没有改动文件');
    await expect(details(f.page).getByLabel('源码 diff')).toHaveCount(0);
    await expect.poll(() => f.app.evaluate(() => __wslSourceFixture.patchRequests.length)).toBeGreaterThanOrEqual(3);
    await f.page.screenshot({ path: testInfo.outputPath('no-changes.png') });
    const queries = await f.app.evaluate(() => __wslSourceFixture.patchRequests.length);
    await f.app.evaluate(() => {
      __wslSourceFixture.unavailable = true;
    });
    expect((await f.start()).ok).toBe(true);
    expect(await f.app.evaluate(() => __wslSourceFixture.sends.length)).toBe(3);
    await f.app.evaluate((_electron, sessionId) => __wslSourceFixture.finish(sessionId), f.sessionId);
    await f.select((await f.run()).runId);
    await expect(details(f.page)).toContainText('源码差异不可用');
    await expect(details(f.page)).toContainText('unsupported source symlink');
    expect(await f.app.evaluate(() => __wslSourceFixture.patchRequests.length)).toBe(queries);
    await f.page.screenshot({ path: testInfo.outputPath('unavailable-diff.png') });
    // 正式构建（未启用诊断）不显示演示记录（OPS-1 S4），真实运行历史保留；诊断启用时的演示记录见 unconnected-capabilities.spec.ts。
    const history = f.page.getByRole('navigation', { name: '任务与运行记录' });
    await expect(history.getByRole('button', { name: /^运行 · / }).first()).toBeVisible();
    await expect(history.getByText('演示记录（独立，只读）', { exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: / · 演示记录$/ })).toHaveCount(0);
    expect(f.rendererErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('D: high-line-count evidence stays intact while PatchView renders bounded pages', async () => {
  test.skip(target !== 'build', 'deterministic Main/service injection uses the built Electron harness');
  const f = await setup();
  try {
    const longPath = 'src/' + '中文路径'.repeat(15) + '.ts';
    await f.app.evaluate((_electron, filePath) => {
      __wslSourceFixture.filePath = filePath;
    }, longPath);
    expect((await f.start()).ok).toBe(true);
    await f.app.evaluate((_electron, sessionId) => {
      __wslSourceFixture.content = '// first-page\n' + '\n'.repeat(110000) + '// last-page\n';
      __wslSourceFixture.finish(sessionId);
    }, f.sessionId);
    await expect.poll(async () => (await f.run()).sourceChange?.state).toBe('captured');
    const run = await f.run();
    expect(run.sourceChange).toMatchObject({ state: 'captured', truncated: false });
    const saved = await f.page.evaluate((runId) => window.studio.workbench.runPatch('taskflow-demo', runId), run.runId);
    expect(saved.patch.split('\n').length).toBeGreaterThan(100000);
    expect(Buffer.byteLength(saved.patch)).toBeLessThan(256 * 1024);
    expect(createHash('sha256').update(saved.patch).digest('hex')).toBe(saved.patchSha256);
    await f.select(run.runId);
    const diff = details(f.page).getByLabel('源码 diff', { exact: true });
    const navigation = details(f.page).getByRole('navigation', { name: '源码 diff 分页', exact: true });
    await expect(diff.locator(':scope > span')).toHaveCount(500);
    await expect(navigation).toContainText('1–500');
    await expect(navigation).toContainText('仅本页');
    await expect(navigation.getByRole('button', { name: '上一页', exact: true })).toBeDisabled();
    await expect(diff).toContainText('+// first-page');
    await expect(diff).not.toContainText('+// last-page');
    const next = navigation.getByRole('button', { name: '下一页', exact: true });
    await next.focus();
    await f.page.keyboard.press('Enter');
    await expect(navigation).toContainText('501–1000');
    await expect(diff.locator(':scope > span')).toHaveCount(500);
    await navigation.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(navigation).toContainText('1–500');
    await navigation.getByRole('button', { name: '末页', exact: true }).click();
    await expect(diff).toContainText('+// last-page');
    expect(await diff.locator(':scope > span').count()).toBeLessThanOrEqual(500);
    await expect(navigation.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await f.page.screenshot({ path: test.info().outputPath('paged-diff-last.png') });
    await navigation.getByRole('button', { name: '首页', exact: true }).click();
    await expect(diff).toContainText('+// first-page');
    expect(await f.page.evaluate((runId) => window.studio.workbench.runPatch('taskflow-demo', runId), run.runId)).toEqual(saved);
    await setWorkspaceTheme(f.page, 'dark');
    await setWindowSize(f.app, 960, 700);
    await expect.poll(() => f.page.evaluate(() => window.innerWidth)).toBe(960);
    // Native resizing completes before React projects the narrow layout and removes the docked rail.
    // Observe the collapsed UI before the navigation helper decides whether it must open Workshop.
    await expect(f.page.locator('.workshop-docked')).toHaveCount(0);
    await expect(f.page.locator('#left-panel-trigger')).toHaveAttribute('aria-expanded', 'false');
    await f.select(run.runId);
    await expect(details(f.page).getByRole('list', { name: '修改文件' })).toContainText(longPath);
    const bounds = await details(f.page)
      .getByRole('listitem')
      .evaluate((item) => {
        const region = item.closest('[aria-label="运行详情"]');
        if (!region) throw new Error('missing diff region');
        const itemBounds = item.getBoundingClientRect();
        const regionBounds = region.getBoundingClientRect();
        return { item: { left: itemBounds.left, right: itemBounds.right }, region: { left: regionBounds.left, right: regionBounds.right } };
      });
    expect(bounds.item.left).toBeGreaterThanOrEqual(bounds.region.left);
    expect(bounds.item.right).toBeLessThanOrEqual(bounds.region.right + 1);
    await f.page.screenshot({ path: test.info().outputPath('paged-diff-narrow-dark.png') });
    // Narrow navigation closes the temporary panel. Widening preserves its pinned preference,
    // but reopening remains an explicit user action after the route change.
    await setWindowSize(f.app, 1440, 900);
    await expect.poll(() => f.page.evaluate(() => window.innerWidth)).toBe(1440);
    await expect(f.page.locator('#left-panel-trigger')).toHaveAttribute('aria-expanded', 'false');
    await f.page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
    await expect(f.page.locator('.workshop-docked')).toBeVisible();
    await expect(f.page.getByRole('button', { name: '取消固定 Workshop', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await f.select(run.runId);
    await expect(
      f.page.getByRole('navigation', { name: 'Workshop 导航' }).getByRole('button', { name: '任务', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(diff.locator(':scope > span')).toHaveCount(500);
    await expect(diff).toContainText('+// first-page');
    await expect(details(f.page).getByRole('list', { name: '修改文件' })).toContainText(longPath);
    expect(await f.page.evaluate((runId) => window.studio.workbench.runPatch('taskflow-demo', runId), run.runId)).toEqual(saved);
    await f.page.screenshot({ path: test.info().outputPath('paged-diff-restored-wide-dark.png') });
    expect(run.validation.state).toBe('not_run');
    expect(run.review).toBeNull();
    expect(f.rendererErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('D: closing an active model run waits for confirmed cleanup and persists its ending diff', async () => {
  test.skip(target !== 'build', 'deterministic Main/service injection uses the built Electron harness');
  const f = await setup();
  let closing: Promise<void> | undefined;
  try {
    expect((await f.start()).ok).toBe(true);
    const runId = (await f.run()).runId;
    const profile = await f.app.evaluate(({ app }) => app.getPath('userData'));
    await f.app.evaluate(() => {
      __wslSourceFixture.content = 'export const label = "before quit";\n';
    });
    closing = f.close();
    await closing;
    const patch = await readFile(path.join(profile, 'runs', runId, 'source.patch'), 'utf8');
    expect(patch).toContain('+export const label = "before quit";');
    expect(f.rendererErrors).toEqual([]);
  } finally {
    if (!closing) await f.close();
  }
});

test('D: cancelled changes stay visible and a late patch response cannot replace the newly selected run', async () => {
  test.skip(target !== 'build', 'deterministic Main/service injection uses the built Electron harness');
  const f = await setup();
  try {
    expect((await f.start()).ok).toBe(true);
    await f.app.evaluate((_electron, sessionId) => {
      __wslSourceFixture.content = 'export const label = "first-result";\n';
      __wslSourceFixture.finish(sessionId);
    }, f.sessionId);
    await expect.poll(async () => (await f.run()).sourceChange?.state).toBe('captured');
    const oldRunId = (await f.run()).runId;
    expect((await f.start()).ok).toBe(true);
    const currentRunId = (await f.run()).runId;
    await f.app.evaluate(() => {
      __wslSourceFixture.content = 'export const label = "cancelled-result";\n';
    });
    expect((await f.command({ type: 'cancelRun', runId: currentRunId })).ok).toBe(true);
    await expect.poll(async () => (await f.run()).sourceChange?.state).toBe('captured');
    expect((await f.run()).state).toBe('cancelled');
    await f.app.evaluate(() => {
      __wslSourceFixture.holdPatches = true;
    });
    await f.select(oldRunId);
    await expect(details(f.page)).toContainText('正在读取源码 diff');
    await expect.poll(() => f.app.evaluate(() => __wslSourceFixture.pendingPatches.length)).toBe(1);
    await f.app.evaluate(() => {
      __wslSourceFixture.holdPatches = false;
    });
    await f.select(currentRunId);
    await expect(details(f.page).locator('.diff-add')).toContainText('cancelled-result');
    await f.app.evaluate(() => __wslSourceFixture.releasePatches());
    await expect(details(f.page).locator('.diff-add')).toContainText('cancelled-result');
    await expect(details(f.page).locator('.diff-add')).not.toContainText('first-result');
    const denied = await f.page.evaluate(async (runId) => {
      try {
        await window.studio.workbench.runPatch('another-space', runId);
        return false;
      } catch {
        return true;
      }
    }, currentRunId);
    expect(denied).toBe(true);
    expect((await f.run()).review).toBeNull();
    expect(f.rendererErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('D: patch read errors and mismatched identities stay unavailable until an explicit successful retry', async () => {
  test.skip(target !== 'build', 'deterministic Main/service injection uses the built Electron harness');
  const f = await setup();
  try {
    expect((await f.start()).ok).toBe(true);
    await f.app.evaluate((_electron, sessionId) => {
      __wslSourceFixture.content = 'export const label = "read-recovered";\n';
      __wslSourceFixture.patchFailure = true;
      __wslSourceFixture.finish(sessionId);
    }, f.sessionId);
    await expect.poll(async () => (await f.run()).sourceChange?.state).toBe('captured');
    await f.select((await f.run()).runId);
    await expect(details(f.page).getByRole('alert')).toContainText('源码 diff 读取失败');
    await expect(details(f.page).getByLabel('源码 diff', { exact: true })).toHaveCount(0);
    const firstQueries = await f.app.evaluate(() => __wslSourceFixture.patchRequests.length);
    await f.app.evaluate(() => {
      __wslSourceFixture.patchFailure = false;
      __wslSourceFixture.patchIdentityMismatch = true;
    });
    await details(f.page).getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(details(f.page).getByRole('alert')).toContainText('运行或摘要身份不一致');
    expect(await f.app.evaluate(() => __wslSourceFixture.patchRequests.length)).toBe(firstQueries + 1);
    await expect(details(f.page).getByLabel('源码 diff', { exact: true })).toHaveCount(0);
    await f.app.evaluate(() => {
      __wslSourceFixture.patchIdentityMismatch = false;
      __wslSourceFixture.holdPatches = true;
    });
    await details(f.page).getByRole('button', { name: '重新读取', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await expect(details(f.page)).toContainText('正在读取源码 diff');
    await expect(details(f.page).getByRole('button', { name: '重新读取', exact: true })).toHaveCount(0);
    await expect.poll(() => f.app.evaluate(() => __wslSourceFixture.pendingPatches.length)).toBe(1);
    await f.app.evaluate(() => __wslSourceFixture.releasePatches());
    await expect(details(f.page).getByLabel('源码 diff', { exact: true })).toContainText('+export const label = "read-recovered";');
    expect((await f.run()).validation.state).toBe('not_run');
    expect((await f.run()).review).toBeNull();
    expect(f.rendererErrors).toEqual([]);
  } finally {
    await f.close();
  }
});
