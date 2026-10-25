import { test, expect, type ElectronApplication } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AppScenarioSchema,
  comparableTrace,
  type AppControlResult,
  type AppScenarioTrace,
  type WorkbenchCommand,
} from '../packages/protocol/src';
import { launchApp, workspaceSnapshot, workshopNavigate } from './helpers';

/**
 * 产品窗口 + 真实 sandbox 受管实例（显式授权，WSL_APP_CONTROL_LIVE=1）。不调用模型：测试引导在 Main↔service
 * 边界代替 guest Codex 轮次（见 fixtures/app-control-injection.ts），其余为真实路径：Main 冻结 run、dispatcher、
 * 产品 Browser 的 CDP、service AppService、sandbox 中的应用与 PGlite。guest MCP/CLI 到 service 的帧由单元测试覆盖。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixed = path.join(root, 'tests/app-control/fixed-task');
const evidenceRoot = path.resolve(
  process.env['WSL_APP_CONTROL_EVIDENCE'] ?? path.join(root, 'test-results/app-control-live', randomUUID()),
);
const results: Record<string, unknown> = {};
const sbx = process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx';
const sandbox = process.env['WSL_SBX_NAME'] ?? 'wsl-sbx-smoke-20261006';
const SQL = "SELECT value FROM records WHERE user_id = 'A' AND key = 'welcome'";

async function record(name: string, value: unknown) {
  results[name] = value;
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(results, null, 2) + '\n');
}
const call = (app: ElectronApplication, tool: string, args: Record<string, unknown> = {}, abortAfterMs?: number) =>
  app.evaluate(
    (_electron, input) =>
      (
        globalThis as unknown as { __wslAppCall(tool: string, args: unknown, abortAfterMs?: number): Promise<AppControlResult> }
      ).__wslAppCall(input.tool, input.args, input.abortAfterMs),
    { tool, args, abortAfterMs },
  );
const code = (result: AppControlResult) => (result.ok ? 'ok' : result.error.code);
const data = <T = Record<string, unknown>>(result: AppControlResult): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data as T;
};
async function windowShot(app: ElectronApplication, name: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0]!.capturePage()).toPNG().toString('base64'),
  );
  await writeFile(path.join(evidenceRoot, name), Buffer.from(png, 'base64'));
}
async function guestWrite(file: string, content: string) {
  const child = spawn(sbx, ['exec', '-i', sandbox, 'sh', '-c', 'cat > "$1"', 'sh', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(content);
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  if (exitCode !== 0) throw new Error(`guest write failed (${exitCode}): ${stderr}`);
}

test('product window + live sandbox app: control plane A03/A07 without model', async () => {
  test.skip(process.env['WSL_APP_CONTROL_LIVE'] !== '1', 'explicit live sandbox authorization required; no model is called');
  test.setTimeout(1_200_000);
  const scenario = AppScenarioSchema.parse(JSON.parse(await readFile(path.join(fixed, 'scenario.json'), 'utf8')));
  // 档案留在临时目录；只把本 run 的控制面审计与场景证据复制进证据目录。
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-app-control-live-'));
  const { app, page } = await launchApp({ live: true, appControlInjection: true, userData });
  const command = async (input: Omit<WorkbenchCommand, 'commandId' | 'workspaceId'> & Record<string, unknown>) => {
    const result = await page.evaluate((input) => window.studio.workbench.command(input as never), {
      ...input,
      commandId: randomUUID(),
      workspaceId: 'taskflow-demo',
    });
    expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true);
    return result;
  };
  const space = async () => (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === 'taskflow-demo')!;
  const waitApp = async (predicate: (app: NonNullable<Awaited<ReturnType<typeof space>>['managedApp']>) => boolean, label: string) => {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const current = (await space()).managedApp;
      if (current && predicate(current)) return current;
      if (current?.state === 'failed') throw new Error(`App failed while waiting for ${label}: ${current.error}`);
      await page.waitForTimeout(500);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify((await space()).managedApp)}`);
  };
  const browserResource = async () => {
    const w = await space();
    return w.resources.find((resource) => resource.appProjectId === w.managedApp?.projectId)!;
  };
  const generation = async () => (await browserResource()).preview!.page.documentGeneration;
  try {
    await workshopNavigate(page, '空间');
    await page.getByRole('button', { name: '新建 App', exact: true }).click();
    await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
    const createForm = page.getByRole('dialog', { name: '创建 App', exact: true });
    await createForm.getByLabel('App 名称').fill('Live 标准应用');
    await createForm.getByRole('button', { name: '保存 App' }).click();
    await expect(createForm).not.toBeVisible();
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await waitApp((current) => current.state === 'created', 'created');
    await page.getByRole('button', { name: '启动应用', exact: true }).click();
    let instance = await waitApp((current) => current.state === 'running', 'running');
    await page.getByRole('dialog', { name: '空间 App' }).getByRole('button', { name: '关闭', exact: true }).click();
    await expect
      .poll(async () => (await browserResource())?.preview?.page.url ?? '', { timeout: 30_000 })
      .toContain(new URL(instance.url!).host);
    await record('environment', {
      sandbox,
      projectId: instance.projectId,
      guestCwd: instance.guestCwd,
      firstInstance: instance.appInstanceId,
    });

    // 任务确认与运行：Main 冻结真实 scope；`send` 由测试引导回送 running 会话，不启动 Codex。
    const sessionId = (await space()).sessions[0]!.sessionId;
    const task = JSON.parse(await readFile(path.join(fixed, 'task.json'), 'utf8')) as { goal: string };
    await command({
      type: 'confirmTask',
      sessionId,
      goal: task.goal,
      targetRef: null,
      appId: null,
      captureId: null,
      allowedScopes: ['app.data.reset'],
      acceptance: ['固定场景通过'],
    });
    const version = (await space()).sessions[0]!.taskVersions.at(-1)!;
    await command({ type: 'startRun', sessionId, taskVersionId: version.taskVersionId });
    await expect.poll(async () => (await space()).runs.at(-1)?.state, { timeout: 30_000 }).toBe('running');
    const runId = (await space()).runs.at(-1)!.runId;

    const described = data<{ stale: unknown; manifest: { testids: { testid: string }[] } | null; currentRevision: string }>(
      await call(app, 'app.describe'),
    );
    expect(described.stale).toEqual({ manifest: false, build: false });
    await record('live.describe', {
      stale: described.stale,
      revision: described.currentRevision,
      testids: described.manifest?.testids.map((item) => item.testid),
    });

    // 原版：引用流程与固定基准前置检测。
    const snapshot = data<{ snapshotId: string; documentGeneration: number; elements: { ref: string; testid: string | null }[] }>(
      await call(app, 'app.ui.snapshot'),
    );
    const refresh = snapshot.elements.find((element) => element.testid === 'health-refresh')!;
    const clicked = await call(app, 'app.ui.act', {
      appInstanceId: instance.appInstanceId,
      documentGeneration: snapshot.documentGeneration,
      action: { type: 'click', target: { ref: refresh.ref, snapshotId: snapshot.snapshotId } },
    });
    expect(code(clicked)).toBe('ok');
    await expect
      .poll(async () => JSON.stringify(data(await call(app, 'app.state.read', { names: ['app.health'] }))), { timeout: 15_000 })
      .toContain('"status":"ok"');
    expect(code(await call(app, 'app.data.reset', { appInstanceId: instance.appInstanceId, confirm: 'reset-instance-data' }))).toBe('ok');
    const precheck = data<{ trace: AppScenarioTrace }>(
      await call(app, 'app.scenario.run', { appInstanceId: instance.appInstanceId, scenario }),
    );
    expect(precheck.trace.outcome).toBe('failed');
    expect(precheck.trace.steps[1]).toMatchObject({ error: { code: 'wait_timeout' } });
    await record('live.precheck', { clicked: code(clicked), outcome: precheck.trace.outcome, failedStep: precheck.trace.steps[1] });

    // 写入参考实现（代替 Agent 的源码修改）→ stale → app.restart 重建。
    await guestWrite(`${instance.guestCwd}/src/App.tsx`, await readFile(path.join(fixed, 'reference/App.tsx'), 'utf8'));
    const staleAct = await call(app, 'app.ui.act', {
      appInstanceId: instance.appInstanceId,
      documentGeneration: await generation(),
      action: { type: 'press', key: 'Tab' },
    });
    const staleDescribe = data<{ stale: unknown }>(await call(app, 'app.describe')).stale;
    expect(code(staleAct)).toBe('manifest_stale');
    const restart = await call(app, 'app.restart', { appInstanceId: instance.appInstanceId });
    expect(code(restart)).toBe('ok');
    const previous = instance.appInstanceId;
    instance = await waitApp((current) => current.state === 'running' && current.appInstanceId !== previous, 'restarted');
    await expect
      .poll(async () => (await browserResource())?.preview?.page.url ?? '', { timeout: 30_000 })
      .toContain(new URL(instance.url!).host);
    // AI 发起的重启期间 Browser 标签保持可见：不得出现“实例已停止”错误提示。
    await expect(page.getByText('应用实例已停止或需要重新启动')).toHaveCount(0);
    const oldInstance = await call(app, 'app.ui.act', {
      appInstanceId: previous,
      documentGeneration: await generation(),
      action: { type: 'press', key: 'Tab' },
    });
    const recovered = data<{ stale: unknown }>(await call(app, 'app.describe')).stale;
    expect(code(oldInstance)).toBe('stale_instance');
    expect(recovered).toEqual({ manifest: false, build: false });
    await record('live.restart', {
      staleAct,
      staleDescribe,
      restart,
      previous,
      next: instance.appInstanceId,
      oldInstance: code(oldInstance),
      recovered,
    });

    // A03：产品窗口中经 UI 动作完成固定基准，两次回放一致。
    const traces: AppScenarioTrace[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(code(await call(app, 'app.data.reset', { appInstanceId: instance.appInstanceId, confirm: 'reset-instance-data' }))).toBe('ok');
      const run = data<{ trace: AppScenarioTrace; evidence: unknown }>(
        await call(app, 'app.scenario.run', { appInstanceId: instance.appInstanceId, scenario }),
      );
      traces.push(run.trace);
      await record(`live.A03.scenario.${attempt + 1}`, {
        outcome: run.trace.outcome,
        evidence: run.evidence,
        steps: run.trace.steps.map((step) => [step.summary, step.outcome, step.error?.code ?? null]),
        stateDiff: run.trace.stateDiff,
      });
    }
    expect(traces.map((trace) => trace.outcome)).toEqual(['passed', 'passed']);
    expect(comparableTrace(traces[0]!)).toEqual(comparableTrace(traces[1]!));
    const post = data<{ rows: unknown[] }>(await call(app, 'app.data.query', { sql: SQL }));
    expect(post.rows).toEqual([{ value: '固定验收 2026' }]);
    await windowShot(app, 'A03-product-window-after-scenario.png');
    await record('live.A03.post', { rows: post.rows, appInstanceId: traces[0]!.appInstanceId, sourceRevision: traces[0]!.sourceRevision });

    // A07：AI 等待中，用户在产品 Browser 区点击 → paused_by_user；工作台指示与恢复按钮；焦点不被 AI 抢占。
    await expect(page.getByTestId('agent-control-active')).toBeVisible();
    const address = page.getByRole('textbox').first();
    await address.focus();
    const focusBefore = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML.slice(0, 120) ?? null,
      hasFocus: document.hasFocus(),
    }));
    const previewId = (await browserResource()).preview!.page.webContentsId;
    const waiting = call(app, 'app.ui.act', {
      appInstanceId: instance.appInstanceId,
      documentGeneration: await generation(),
      action: { type: 'waitFor', target: { testid: 'never-appears' }, timeoutMs: 9000 },
    });
    await page.waitForTimeout(1200);
    const focusDuring = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML.slice(0, 120) ?? null,
      hasFocus: document.hasFocus(),
    }));
    await app.evaluate(({ webContents }, id) => {
      const target = webContents.fromId(id)!;
      target.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
      target.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    }, previewId);
    const paused = await waiting;
    await expect(page.getByTestId('agent-control-paused')).toBeVisible();
    await windowShot(app, 'A07-paused-indicator.png');
    const blocked = await call(app, 'app.ui.act', {
      appInstanceId: instance.appInstanceId,
      documentGeneration: await generation(),
      action: { type: 'press', key: 'Tab' },
    });
    const previewFocused = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), previewId);
    await page.getByRole('button', { name: '允许 AI 继续', exact: true }).click();
    await expect(page.getByTestId('agent-control-active')).toBeVisible();
    const resumed = await call(app, 'app.ui.act', {
      appInstanceId: instance.appInstanceId,
      documentGeneration: await generation(),
      action: { type: 'press', key: 'Tab' },
    });
    await windowShot(app, 'A07-resumed.png');
    await record('live.A07', {
      paused,
      blocked: code(blocked),
      resumed: code(resumed),
      focusBefore,
      focusDuring,
      previewFocusedAfterUserClick: previewFocused,
    });
    expect(code(paused)).toBe('paused_by_user');
    expect(code(blocked)).toBe('paused_by_user');
    expect(focusDuring).toEqual(focusBefore);
    expect(code(resumed)).toBe('ok');

    // 停止后：只读 describe/query 走 guest agent-cli；写操作拒绝。随后取消 run，指示消失。
    await page.getByRole('button', { name: '管理 App', exact: true }).click();
    await page.getByRole('button', { name: '停止应用', exact: true }).click();
    await waitApp((current) => current.state === 'stopped', 'stopped');
    await page.getByRole('dialog', { name: '空间 App' }).getByRole('button', { name: '关闭', exact: true }).click();
    const stoppedQuery = await call(app, 'app.data.query', { sql: SQL });
    const stoppedWrite = await call(app, 'app.data.seed', { appInstanceId: instance.appInstanceId });
    expect(stoppedQuery.ok && stoppedQuery.data.mode).toBe('cli');
    expect(code(stoppedWrite)).toBe('app_not_running');
    await command({ type: 'cancelRun', runId });
    await expect.poll(async () => (await space()).runs.at(-1)?.state, { timeout: 30_000 }).toBe('cancelled');
    const afterRun = await call(app, 'app.status');
    expect(code(afterRun)).toBe('no_active_run');
    await record('live.stopped', { stoppedQuery, stoppedWrite: code(stoppedWrite), afterRun: code(afterRun) });
    const forwarded = await app.evaluate(
      () => (globalThis as unknown as { __wslAppControlLive: { forwarded: string[] } }).__wslAppControlLive.forwarded,
    );
    await record('live.forwardedServiceMethods', [...new Set(forwarded)]);
    await cp(path.join(userData, 'app-control', runId), path.join(evidenceRoot, 'app-control', runId), { recursive: true });
  } finally {
    await app.close();
  }
  const ports = await promisify(execFile)(sbx, ['ports', sandbox, '--json'], { timeout: 20_000 }).then(
    (result) => result.stdout,
    (error: Error) => error.message,
  );
  await record('cleanup.ports', ports);
});
