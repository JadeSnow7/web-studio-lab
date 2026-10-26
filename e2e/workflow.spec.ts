import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, workshopNavigate, windowShots, workspaceSnapshot, target } from './helpers';

/**
 * W4/W5/W6 workflow 命令入口的 Electron E2E：真实 Main↔service↔fixture sbx 链路，
 * 只读内置/保存命令、并发派发、停止清理确认、缓存续跑与崩溃恢复（needs_reconciliation → 标记已停止 → 续跑）、
 * saved 命令的批准绑定（新建 → 待批准 → 批准 → 运行；编辑 → 待批准 → 运行被拒）、
 * W6b lane 候选的发布→显式应用（成功与源漂移冲突）。
 */

const sbxBin = path.resolve('e2e/fixtures/sbx.mjs');

let app: ElectronApplication;
let page: Page;
test.afterEach(async () => {
  if (app) await app.close();
});

function detail() {
  return page.getByRole('region', { name: '工作流详情' });
}

function commandCard(commandId: string) {
  return page.locator(`[data-command-id="${commandId}"]`);
}

function runRow(taskName: string) {
  return page.getByRole('button', { name: new RegExp(`${taskName} · `) }).first();
}

async function runCommand(commandId: string, commandName: string) {
  await commandCard(commandId).getByRole('button', { name: '运行' }).click();
  await expect(runRow(commandName)).toBeVisible({ timeout: 15000 });
  await runRow(commandName).click();
  await expect(detail()).toContainText('状态：', { timeout: 15000 });
}

test('内置命令 diagnose-input 运行到完成：两次调用与 usage 可见', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await workshopNavigate(page, '工作流');
  await runCommand('diagnose-input', '固定输入诊断');
  await expect(detail()).toContainText('已完成', { timeout: 30000 });
  for (const seq of [1, 2]) {
    const row = detail().locator(`[data-call-seq="${seq}"]`);
    await expect(row).toContainText('ok');
    await expect(row).toContainText('in 1000 / out 20');
  }
  await windowShots(app, page, 'workflow-diagnose-input');
});

test('内置命令 diagnose-parallel 并发派发两个调用：先完成先登记，可停止清理确认', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await workshopNavigate(page, '工作流');
  await runCommand('diagnose-parallel', '固定输入并行诊断');
  // 两个调用并行登记：call1 快速完成，call2 [slow] 驻留；交付仍按 callSeq。
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok', { timeout: 30000 });
  await expect(detail().locator('[data-call-seq="2"]')).toBeVisible({ timeout: 15000 });
  await detail().getByRole('button', { name: '停止' }).click();
  await expect(detail()).toContainText('已停止', { timeout: 30000 });
  await windowShots(app, page, 'workflow-diagnose-parallel');
});

test('saved 命令流程：新建 → 待批准 → 批准 → 运行；编辑 → 待批准 → 批准 → 运行', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await workshopNavigate(page, '工作流');

  // 新建命令
  await page.getByRole('button', { name: '新建命令' }).click();
  await page.getByLabel('命令名称').fill('E2E 保存命令');
  await page.getByLabel('命令脚本').fill(
    `export const meta = { name: 'E2E 保存命令', description: '一个只读调用' };
export default async function main() {
  const r = await agent('给出一句话', { label: '回答' });
  return { ok: r.status === 'ok' };
}
`,
  );
  await page.getByLabel('命令 args').fill('{}');
  await page.getByLabel('命令时限').fill('60000');
  await page.getByRole('button', { name: '保存命令', exact: true }).click();

  // 待批准：运行按钮禁用，必须先批准
  const savedCard = page.locator('.workflow-card', { hasText: 'E2E 保存命令' }).last();
  await expect(savedCard).toBeVisible({ timeout: 15000 });
  await expect(savedCard).toContainText('待批准');
  await expect(savedCard.getByRole('button', { name: '运行' })).toBeDisabled();
  await savedCard.getByRole('button', { name: '批准' }).click();
  await expect(savedCard).toContainText('已批准', { timeout: 15000 });

  // 批准后运行到完成
  await savedCard.getByRole('button', { name: '运行' }).click();
  await expect(runRow('E2E 保存命令')).toBeVisible({ timeout: 15000 });
  await runRow('E2E 保存命令').click();
  await expect(detail()).toContainText('已完成', { timeout: 30000 });
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok');

  // 编辑：内容改动使批准失效，运行再次被拒
  await savedCard.getByRole('button', { name: '编辑' }).click();
  await page.getByLabel('命令名称').fill('E2E 保存命令改');
  await page.getByRole('button', { name: '保存命令', exact: true }).click();
  const renamedCard = page.locator('.workflow-card', { hasText: 'E2E 保存命令改' }).last();
  await expect(renamedCard).toContainText('待批准', { timeout: 15000 });
  await expect(renamedCard.getByRole('button', { name: '运行' })).toBeDisabled();
  await renamedCard.getByRole('button', { name: '批准' }).click();
  await expect(renamedCard).toContainText('已批准', { timeout: 15000 });
  await renamedCard.getByRole('button', { name: '运行' }).click();
  await expect(runRow('E2E 保存命令改')).toBeVisible({ timeout: 15000 });
  await windowShots(app, page, 'workflow-saved-command');
});

test('diagnose-slow 停止清理确认后缓存续跑：cached 标记与再次停止', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await workshopNavigate(page, '工作流');
  await runCommand('diagnose-slow', '固定输入慢速诊断');
  // 等 call1 提交 ok 结果（续跑缓存的来源）；call2 驻留 [slow]。
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok', { timeout: 30000 });
  await expect(detail().locator('[data-call-seq="2"]')).toBeVisible({ timeout: 15000 });
  await detail().getByRole('button', { name: '停止' }).click();
  await expect(detail()).toContainText('已停止', { timeout: 30000 });

  await detail().getByRole('button', { name: '续跑' }).click();
  // 续跑生成新 run：等新记录行出现再选中（最新的行在最前），详情才指向续跑 run。
  const rows = page.getByRole('button', { name: /固定输入慢速诊断 · / });
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  await rows.first().click();
  await expect(detail()).toContainText('运行中', { timeout: 15000 });
  // 续跑 run 的 call1 复用已提交结果：cached 标记与出处，不重新派发。
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('cached');
  await detail().getByRole('button', { name: '停止' }).click();
  await expect(detail()).toContainText('已停止', { timeout: 30000 });
  await windowShots(app, page, 'workflow-slow-resume');
});

/** W6b：经 UI 创建受管 App（fixture 持久化工程文件集），等创建命令完成到可绑定状态。 */
async function createManagedApp(name: string) {
  await page.getByRole('button', { name: '新建 App', exact: true }).click();
  await page.getByRole('button', { name: '创建标准应用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建 App', exact: true });
  await dialog.getByLabel('App 名称').fill(name);
  await dialog.getByRole('button', { name: '保存 App' }).click();
  // 创建成功时对话框直接关闭（失败才转「编辑 App」）；绑定就绪以快照事实为准。
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]?.managedApp?.state ?? null, { timeout: 15000 })
    .toBe('created');
}

/** W6b：运行 patch-app 到终态并打开其 run 详情，返回候选面板。 */
async function runPatchApp() {
  await commandCard('patch-app').getByRole('button', { name: '运行' }).click();
  const row = page.getByRole('button', { name: /修改应用（候选） · / }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(detail()).toContainText('已完成', { timeout: 30000 });
  return detail().getByRole('region', { name: '候选快照' });
}

test('W6b patch-app：lane 候选发布 → 查看差异 → 显式应用到受管 App', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await createManagedApp('W6b 候选应用');
  await workshopNavigate(page, '工作流');

  const candidate = await runPatchApp();
  // lane collect 在输入文件集上加了确定性标记文件：候选清单可见该变更。
  await expect(candidate).toContainText('lane-change.txt', { timeout: 15000 });
  await candidate.getByRole('button', { name: '查看差异' }).click();
  await expect(candidate.locator('[data-candidate-patch]')).toContainText('lane-change.txt');

  // 显式授权应用：Main 在写租约下核对基线后经 app-helper apply 写入真实工程。
  await candidate.getByRole('button', { name: '应用候选到应用' }).click();
  await expect(candidate).toContainText('已应用', { timeout: 15000 });

  // fixture 状态文件即远端工程事实：候选文件确实落地，不只是 UI 状态。
  const projectId = (await workspaceSnapshot(page)).workspaces[0]!.managedApp!.projectId;
  const state = JSON.parse(await readFile(path.join(tmpdir(), 'wsl-sbx-fixture-fixture-sandbox.json'), 'utf8'));
  const files = (state.projects as Record<string, { files: { path: string }[] }>)[projectId]!.files.map((f) => f.path);
  expect(files).toContain('lane-change.txt');
  await windowShots(app, page, 'workflow-apply-success');
});

test('W6b patch-app：先应用的候选改写工程后，第二候选以 apply_conflict 拒绝', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await createManagedApp('W6b 冲突应用');
  await workshopNavigate(page, '工作流');

  // 两次 run 基于同一基线各产出一个不同候选；先应用较旧的 run，再应用较新的必然漂移冲突。
  const first = await runPatchApp();
  await expect(first).toContainText('lane-change.txt', { timeout: 15000 });
  await commandCard('patch-app').getByRole('button', { name: '运行' }).click();
  const rows = page.getByRole('button', { name: /修改应用（候选） · / });
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  // run 行最新在前：first() 是第二次 run，last() 是第一次 run。
  await rows.first().click();
  const second = detail().getByRole('region', { name: '候选快照' });
  await expect(detail()).toContainText('已完成', { timeout: 30000 });
  await expect(second).toContainText('lane-change.txt', { timeout: 15000 });

  await rows.last().click();
  const firstPanel = detail().getByRole('region', { name: '候选快照' });
  await firstPanel.getByRole('button', { name: '应用候选到应用' }).click();
  await expect(firstPanel).toContainText('已应用', { timeout: 15000 });

  await rows.first().click();
  await second.getByRole('button', { name: '应用候选到应用' }).click();
  await expect(page.getByRole('alert')).toContainText('apply_conflict', { timeout: 15000 });
  await expect(second).not.toContainText('已应用');
  await windowShots(app, page, 'workflow-apply-conflict');
});

test('W8 patch-app-wave：两 lane 并行 → 合并发布并显式应用到受管 App', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await createManagedApp('W8 波次应用');
  await workshopNavigate(page, '工作流');

  await commandCard('patch-app-wave').getByRole('button', { name: '运行' }).click();
  const row = page.getByRole('button', { name: /波次修改应用（候选） · / }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(detail()).toContainText('已完成', { timeout: 30000 });
  // 两个 lane 调用都 ok（合并发布无冲突）。
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok');
  await expect(detail().locator('[data-call-seq="2"]')).toContainText('ok');

  const candidate = detail().getByRole('region', { name: '候选快照' });
  // 候选面板展示最新一次发布的变更清单；标记名按 collect 物理顺序分配（不绑定 callSeq），
  // 故只断言出现了 lane 标记文件——两个标记的并集由应用后的工程文件断言。
  await expect(candidate).toContainText('lane-', { timeout: 15000 });

  // 显式应用：合并树（两个 lane 的并集）落地到真实工程。
  await candidate.getByRole('button', { name: '应用候选到应用' }).click();
  await expect(candidate).toContainText('已应用', { timeout: 15000 });
  const projectId = (await workspaceSnapshot(page)).workspaces[0]!.managedApp!.projectId;
  const state = JSON.parse(await readFile(path.join(tmpdir(), 'wsl-sbx-fixture-fixture-sandbox.json'), 'utf8'));
  const files = (state.projects as Record<string, { files: { path: string }[] }>)[projectId]!.files.map((f) => f.path);
  expect(files).toEqual(expect.arrayContaining(['lane-change.txt', 'lane-2.txt']));
  await windowShots(app, page, 'workflow-wave-apply');
});

test('W8 波次冲突：两 lane 改同一文件 → 后者 conflict 终态且候选保留可见', async () => {
  ({ app, page } = await launchApp({ sbxBin }));
  await createManagedApp('W8 冲突应用');
  await workshopNavigate(page, '工作流');

  // saved 命令：两个 [wave-conflict] lane 在 parallel 内改 shared.txt → 后者合并冲突。
  await page.getByRole('button', { name: '新建命令' }).click();
  await page.getByLabel('命令名称').fill('W8 冲突波次');
  await page.getByLabel('命令脚本').fill(
    `export const meta = { name: 'W8 冲突波次', description: '两个 lane 改同一文件', phases: ['wave'] };
export default async function main() {
  phase('wave');
  const [a, b] = await parallel([
    () => agent('[wave-conflict] 写 shared.txt 版本一', { label: 'wave-1', isolation: 'lane' }),
    () => agent('[wave-conflict] 写 shared.txt 版本二', { label: 'wave-2', isolation: 'lane' }),
  ]);
  return [a.status, b.status];
}
`,
  );
  await page.getByLabel('命令 args').fill('{}');
  await page.getByLabel('命令时限').fill('300000');
  await page.getByRole('button', { name: '保存命令', exact: true }).click();
  const card = page.locator('.workflow-card', { hasText: 'W8 冲突波次' }).last();
  await card.getByRole('button', { name: '批准' }).click();
  await card.getByRole('button', { name: '运行' }).click();
  const row = page.getByRole('button', { name: /W8 冲突波次 · / }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(detail()).toContainText('已完成', { timeout: 30000 });

  // 先发布的 lane ok；冲突的 lane 记 conflict 终态并展示冲突文件（不算 run 失败）。
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok');
  const conflictRow = detail().locator('[data-call-seq="2"]');
  await expect(conflictRow).toContainText('conflict');
  await expect(conflictRow).toContainText('shared.txt');
  await windowShots(app, page, 'workflow-wave-conflict');
});

function hasW9ReasoningArgv(log: string, runId: string): boolean {
  return log
    .trim()
    .split('\n')
    .filter(Boolean)
    .some((line) => {
      const entry: unknown = JSON.parse(line);
      return (
        typeof entry === 'object' &&
        entry !== null &&
        'runId' in entry &&
        entry.runId === runId &&
        'mode' in entry &&
        entry.mode === 'codex' &&
        'argv' in entry &&
        Array.isArray(entry.argv) &&
        entry.argv.includes('model_reasoning_effort=high')
      );
    });
}

test('W9：tier 档位经 argv 到达 guest（model_reasoning_effort）+ Ultra 徽标可见', async () => {
  const sandbox = `fixture-w9-${randomUUID()}`;
  ({ app, page } = await launchApp({ sbxBin, sandbox }));
  await workshopNavigate(page, '工作流');

  // saved 命令：meta.ultra=true + tier:'big' 调用——批准绑定照常（ultra 零特权）。
  await page.getByRole('button', { name: '新建命令' }).click();
  await page.getByLabel('命令名称').fill('W9 档位与 Ultra');
  await page.getByLabel('命令脚本').fill(
    `export const meta = { name: 'W9 档位与 Ultra', description: 'tier big + ultra 标记', ultra: true };
export default async function main() {
  const r = await agent('给出一句话', { label: '档位调用', tier: 'big' });
  return { ok: r.status === 'ok' };
}
`,
  );
  await page.getByLabel('命令 args').fill('{}');
  await page.getByLabel('命令时限').fill('60000');
  await page.getByRole('button', { name: '保存命令', exact: true }).click();
  const card = page.locator('.workflow-card', { hasText: 'W9 档位与 Ultra' }).last();
  await card.getByRole('button', { name: '批准' }).click();
  await card.getByRole('button', { name: '运行' }).click();
  const row = page.getByRole('button', { name: /W9 档位与 Ultra · / }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  const runId = await row.getAttribute('title');
  if (runId === null) throw new Error('W9 run row is missing its runId');
  // Ultra 徽标：run 行与详情都标记（零特权，仅展示/实验分组）。
  await expect(row).toContainText('Ultra', { timeout: 15000 });
  await row.click();
  await expect(detail()).toContainText('已完成', { timeout: 30000 });
  await expect(detail().locator('[data-ultra-badge]')).toContainText('Ultra');
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok');

  // fixture 记录的 start argv：tier:'big' 映射为 model_reasoning_effort=high。
  const argvLog = path.join(tmpdir(), `wsl-sbx-argv-${sandbox}.jsonl`);
  await expect
    .poll(
      async () => {
        try {
          return hasW9ReasoningArgv(await readFile(argvLog, 'utf8'), runId);
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await windowShots(app, page, 'workflow-w9-tier-ultra');
});

test('强制杀死所属 Electron：重启后 needs_reconciliation → 标记已停止 → 可续跑', async ({ browserName: _browserName }, testInfo) => {
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-wf-'));
  ({ app, page } = await launchApp({ sbxBin, userData }));
  await workshopNavigate(page, '工作流');
  await runCommand('diagnose-slow', '固定输入慢速诊断');
  // Force only this test-owned Electron to crash; normal window close now confirms cleanup.
  // Keep call1 as a committed cache source while call2 remains active.
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok', { timeout: 30000 });
  await expect(detail().locator('[data-call-seq="2"]')).toBeVisible({ timeout: 15000 });
  const ownedProcess = app.process();
  const closed = app.waitForEvent('close');
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    ownedProcess.once('exit', (code, signal) => resolve({ code, signal })),
  );
  expect(ownedProcess.kill('SIGKILL')).toBe(true);
  const [, exit] = await Promise.all([closed, exited]);
  expect(exit.signal).toBe('SIGKILL');
  await testInfo.attach('owned-electron-crash.json', {
    body: JSON.stringify({ pid: ownedProcess.pid, closeObserved: true, ...exit }),
    contentType: 'application/json',
  });

  await app.close();
  ({ app, page } = await launchApp({ sbxBin, userData }));
  await workshopNavigate(page, '工作流');
  await runRow('固定输入慢速诊断').click();
  await expect(detail()).toContainText('待核对', { timeout: 15000 });
  await detail().getByRole('button', { name: '标记已停止' }).click();
  await expect(detail()).toContainText('已停止', { timeout: 15000 });
  await detail().getByRole('button', { name: '续跑' }).click();
  const rows = page.getByRole('button', { name: /固定输入慢速诊断 · / });
  await expect(rows).toHaveCount(2, { timeout: 15000 });
  await rows.first().click();
  await expect(detail()).toContainText('运行中', { timeout: 15000 });
  await detail().getByRole('button', { name: '停止' }).click();
  await expect(detail()).toContainText('已停止', { timeout: 30000 });
  await windowShots(app, page, 'workflow-reconcile-resume');
});

test('active slow Workflow window close confirms cleanup and exits without a failure dialog', async () => {
  test.skip(target !== 'build', 'Intercepts native dialog in the isolated build fixture.');
  const userData = await mkdtemp(path.join(tmpdir(), 'wsl-e2e-wf-active-close-'));
  ({ app, page } = await launchApp({ sbxBin, userData }));
  await workshopNavigate(page, '工作流');
  await runCommand('diagnose-slow', '固定输入慢速诊断');
  await expect(detail().locator('[data-call-seq="1"]')).toContainText('ok', { timeout: 30000 });
  const runId = await runRow('固定输入慢速诊断').getAttribute('title');
  if (runId === null) throw new Error('Workflow run row is missing its runId');
  const journal = new DatabaseSync(path.join(userData, 'workflow', 'journal.sqlite'), { readOnly: true });
  try {
    // calls.attempts counts completed attempts; an active attempt is a committed journal fact.
    const activeAttempt = journal.prepare(`SELECT r.status AS runStatus, a.status AS attemptStatus,
               (SELECT COUNT(*) FROM events e
                WHERE e.run_id = a.run_id AND e.kind = 'attempt_start'
                  AND json_extract(e.json, '$.callSeq') = a.call_seq
                  AND json_extract(e.json, '$.attempt') = a.attempt) AS attemptStarts,
               (SELECT COUNT(*) FROM events e
                WHERE e.run_id = a.run_id AND e.kind = 'attempt_end'
                  AND json_extract(e.json, '$.callSeq') = a.call_seq
                  AND json_extract(e.json, '$.attempt') = a.attempt) AS attemptEnds,
               (SELECT COUNT(*) FROM events e
                WHERE e.run_id = a.run_id AND e.kind = 'call_end'
                  AND json_extract(e.json, '$.callSeq') = a.call_seq) AS callEnds
        FROM attempts a JOIN runs r ON r.run_id = a.run_id
        WHERE a.run_id = ? AND a.call_seq = ? AND a.attempt = ?`);
    await expect
      .poll(() => activeAttempt.get(runId, 2, 1), { timeout: 15000 })
      .toEqual({
        runStatus: 'running',
        attemptStatus: 'running',
        attemptStarts: 1,
        attemptEnds: 0,
        callEnds: 0,
      });
  } finally {
    journal.close();
  }
  await expect(detail()).toContainText('运行中');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => {
      throw new Error('Unexpected workflow cleanup failure dialog');
    };
  });
  const ownedProcess = app.process();
  const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await Promise.all([closed, exited]);
  expect(ownedProcess.exitCode).toBe(0);
});

test('automatic Workflow cleanup failure stays unreconciled and requires explicit exit confirmation', async () => {
  test.skip(target !== 'build', 'Intercepts native dialog in the isolated build fixture.');
  ({ app, page } = await launchApp({ sbxBin }));
  await app.evaluate(({ dialog }) => {
    const state = { dialogs: [] as Electron.MessageBoxOptions[], response: 1 };
    Object.assign(globalThis, { workflowShutdownTest: state });
    dialog.showMessageBox = async (...args: unknown[]) => {
      state.dialogs.push(args.at(-1) as Electron.MessageBoxOptions);
      return { response: state.response, checkboxChecked: false };
    };
  });
  try {
    await workshopNavigate(page, '工作流');
    await page.getByRole('button', { name: '新建命令' }).click();
    await page.getByLabel('命令名称').fill('E2E cleanup owner');
    await page.getByLabel('命令脚本').fill(`export const meta = {name:'E2E cleanup owner',description:'negative cleanup receipt'};
export default async function main(){ return agent('[cleanup-fail] confirm owner',{label:'cleanup'}); }`);
    await page.getByLabel('命令 args').fill('{}');
    await page.getByLabel('命令时限').fill('60000');
    await page.getByRole('button', { name: '保存命令', exact: true }).click();
    const card = page.locator('.workflow-card', { hasText: 'E2E cleanup owner' }).last();
    await card.getByRole('button', { name: '批准' }).click();
    await card.getByRole('button', { name: '运行' }).click();
    await runRow('E2E cleanup owner').click();
    await expect(detail()).toContainText('待核对', { timeout: 30000 });
    await card.getByRole('button', { name: '运行' }).click();
    await expect(page.getByRole('alert')).toContainText('run_busy');
    await expect(page.getByRole('button', { name: /E2E cleanup owner · / })).toHaveCount(1);
    await detail().getByRole('button', { name: '标记已停止' }).click();
    await expect(page.getByRole('alert')).toContainText('process_unconfirmed');
    await expect(detail()).toContainText('待核对');
    await expect(detail().getByRole('button', { name: '续跑' })).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'workflowShutdownTest').dialogs.length)).toBe(1);
    expect(page.isClosed()).toBe(false);
    const options = await app.evaluate(() => Reflect.get(globalThis, 'workflowShutdownTest').dialogs[0] as Electron.MessageBoxOptions);
    expect(options.message).toContain('清理未确认');
    expect(options.detail).toContain('cleanup unconfirmed');
    expect(options.defaultId).toBe(1);
    await app.evaluate(() => {
      Reflect.get(globalThis, 'workflowShutdownTest').response = 2;
    });
    const ownedProcess = app.process();
    const exited = new Promise<void>((resolve) => ownedProcess.once('exit', () => resolve()));
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await Promise.all([closed, exited]);
    expect(ownedProcess.exitCode).toBe(0);
  } finally {
    if (!page.isClosed()) {
      await app.evaluate(() => {
        Reflect.get(globalThis, 'workflowShutdownTest').response = 2;
      });
    }
  }
});
