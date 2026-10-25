import { codexHarnessRuntime } from './harness-test-fixture';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkbenchCommandSchema,
  type ChatConversation,
  type WorkbenchCommand,
  type WorkbenchRun,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import type { WorkbenchRuntime } from './ports';
import { PRODUCT_CHECKER, validationResult } from './checker';
import { getExecutionStatus } from '../execution';

/*
 * OPS-1 O06a（D1 = A）：检查器未接入只改变呈现，不放宽接受门槛。
 * 检查结果只经应用端口（仓库 load）注入；产品代码中没有产生 passed 的路径，也不新增测试门控的假检查器（SPEC §9.4）。
 */

const conversation = (sessionId: string): ChatConversation => ({
  conversationId: sessionId,
  generation: 'acceptance-gate',
  seq: 1,
  state: 'idle',
  turnId: 'one',
  threadId: 'thread',
  messages: [{ id: 'one:reply', role: 'assistant', text: 'reply' }],
  toolExecutions: [],
  warnings: [],
  cleanupPending: false,
  error: null,
});

async function completedRun() {
  let saved: WorkbenchSnapshot | null = null;
  const repository = {
    appendObservation: vi.fn(async () => crypto.randomUUID()),
    migrationPending: false,
    loadCatalog: catalogForTestSnapshot,
    load: async () => structuredClone(saved),
    save: vi.fn(async (snapshot: WorkbenchSnapshot) => {
      saved = structuredClone(snapshot);
    }),
  };
  const runtime = {
    ...codexHarnessRuntime,
    environmentsList: vi.fn().mockResolvedValue([
      {
        environmentId: 'local',
        kind: 'local',
        state: 'configured',
        label: '本机',
        capabilities: { browser: true, files: true, terminal: true },
        reason: null,
      },
    ]),
    registerResource: vi.fn(),
    releaseResource: vi.fn(),
    observe: vi.fn(),
    validateBrowserUrl: vi.fn(),
    registerSession: vi.fn(),
    send: vi.fn(),
    hideBrowsers: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  const session = (await app.getSnapshot()).workspaces[0]!.sessions[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', ...payload } as WorkbenchCommand);
  await command({
    type: 'confirmTask',
    sessionId: session.sessionId,
    goal: 'acceptance gate',
    targetRef: null,
    appId: null,
    captureId: null,
  });
  const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
  vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId));
  expect((await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
  const run = (await app.getSnapshot()).workspaces[0]!.runs[0]!;
  expect(run.state).toBe('completed');
  expect(run.validation).toEqual({ state: 'not_run', applicability: 'unknown', reason: null });

  /** 经应用端口注入检查结果：写入仓库后由新的应用实例加载，等价于 E2E 预置 workbench.json。 */
  const restoreWith = async (validation: WorkbenchRun['validation']) => {
    const snapshot = await app.getSnapshot();
    snapshot.workspaces[0]!.runs[0]!.validation = validation;
    await repository.save(snapshot);
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await restored.getSnapshot();
    return restored;
  };
  const accept = (target: WorkbenchApplication, candidateId = run.candidateId) =>
    target.command({
      commandId: crypto.randomUUID(),
      workspaceId: 'taskflow-demo',
      type: 'recordReview',
      runId: run.runId,
      candidateId,
      decision: 'accepted',
    });
  return { app, run, repository, restoreWith, accept, command };
}

describe('O06a 接受门槛（D1 = A）', () => {
  it.each([
    ['未检查', { state: 'not_run', applicability: 'unknown', reason: null }],
    ['检查失败', { state: 'failed', applicability: 'current', reason: '断言失败' }],
    ['blocked（仅原因文字）', { state: 'blocked', applicability: 'unknown', reason: '独立检查适配器尚未接入；Agent 文本不能作为检查结果' }],
    ['检查已失效', { state: 'passed', applicability: 'stale', reason: null }],
    ['检查适用性未知', { state: 'passed', applicability: 'unknown', reason: null }],
  ] as const)('%s：recordReview(accepted) 被拒绝且不写审阅', async (_name, validation) => {
    const { restoreWith, accept } = await completedRun();
    const restored = await restoreWith(validation);
    const result = await accept(restored);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
    expect(result.snapshot.workspaces[0]!.runs[0]!.review).toBeNull();
    expect(result.snapshot.workspaces[0]!.runs[0]!.validation).toEqual(validation);
  });

  it('候选不匹配：即使检查 passed 且 current 也被拒绝', async () => {
    const { restoreWith, accept } = await completedRun();
    const restored = await restoreWith({ state: 'passed', applicability: 'current', reason: null });
    const result = await accept(restored, crypto.randomUUID());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
    expect(result.snapshot.workspaces[0]!.runs[0]!.review).toBeNull();
  });

  it('经端口注入的 passed + current 检查结果仍能接受，审阅绑定当前候选', async () => {
    const { run, restoreWith, accept } = await completedRun();
    const restored = await restoreWith({ state: 'passed', applicability: 'current', reason: null });
    const result = await accept(restored);
    expect(result.ok).toBe(true);
    const review = result.snapshot.workspaces[0]!.runs[0]!.review;
    expect(review).toMatchObject({ decision: 'accepted', candidateId: run.candidateId });
  });

  it('runValidation 的 Main 行为不变：仍记录 blocked 与原因文字，之后的接受被拒绝', async () => {
    const { app, run, accept, command } = await completedRun();
    expect((await command({ type: 'runValidation', runId: run.runId })).ok).toBe(true);
    const validation = (await app.getSnapshot()).workspaces[0]!.runs[0]!.validation;
    expect(validation).toEqual({
      state: 'blocked',
      applicability: 'unknown',
      reason: '独立检查适配器尚未接入；Agent 文本不能作为检查结果',
    });
    const result = await accept(app);
    expect(result.ok).toBe(false);
    expect(result.snapshot.workspaces[0]!.runs[0]!.review).toBeNull();
  });

  it('检查器能力在 Main 只有一个来源：ExecutionStatus 与 runValidation 都由 PRODUCT_CHECKER 派生', async () => {
    expect(getExecutionStatus().checker).toEqual(PRODUCT_CHECKER);
    const { app, run, command } = await completedRun();
    expect((await command({ type: 'runValidation', runId: run.runId })).ok).toBe(true);
    expect((await app.getSnapshot()).workspaces[0]!.runs[0]!.validation).toEqual(validationResult(PRODUCT_CHECKER));
    // 能力若翻成“已接入”而没有检查器实现，runValidation 拒绝，而不是悄悄记成“未接入”。
    expect(() => validationResult({ connected: true })).toThrow(/^unsupported:/);
  });

  it('协议没有 accepted_unchecked：边界 schema 拒绝该决定', () => {
    const base = { commandId: 'c', workspaceId: 'taskflow-demo', type: 'recordReview', runId: 'r', candidateId: 'cand' };
    expect(WorkbenchCommandSchema.safeParse({ ...base, decision: 'accepted' }).success).toBe(true);
    expect(WorkbenchCommandSchema.safeParse({ ...base, decision: 'accepted_unchecked' }).success).toBe(false);
  });
});
