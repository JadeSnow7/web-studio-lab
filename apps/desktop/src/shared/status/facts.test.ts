import { describe, expect, it } from 'vitest';
import {
  ChatConversationSchema,
  ObservationRecordSchema,
  SetupSnapshotSchema,
  StatusFactSchema,
  StatusRawSchemas,
  WorkbenchSnapshotSchema,
  type ChatStatus,
  type ExecutionStatus,
  type ObservationRecord,
  type StatusFact,
  type WorkbenchRun,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { projectFacts, type FactInput } from './index';

/* ---------- 夹具：全部用协议 schema 解析，保证形状合法 ---------- */

const WS = 'ws';
const page = { webContentsId: 7, documentGeneration: 3, url: 'https://example.com/a?token=SECRET#frag', title: '网页', partition: 'p' };
const previewState = (overrides: Record<string, unknown> = {}) => ({
  page,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  picking: false,
  cdp: { state: 'attached' },
  consoleIssueCount: 0,
  loadError: null,
  blockedNavigation: null,
  pickError: null,
  ...overrides,
});
const terminalState = (overrides: Record<string, unknown> = {}) => ({
  seq: 1,
  sessionId: 'pty-1',
  sandbox: 'sandbox-abc',
  cwd: '/work/project',
  state: 'running',
  output: 'SECRET-TERMINAL-OUTPUT',
  outputOffset: 0,
  cleanupPending: false,
  error: null,
  ...overrides,
});
const resource = (resourceId: string, overrides: Record<string, unknown> = {}) => ({
  resourceId,
  kind: 'web',
  environmentId: 'local',
  title: resourceId,
  url: null,
  instanceId: `${resourceId}-inst`,
  generation: 1,
  preview: null,
  terminal: null,
  unavailableReason: null,
  ...overrides,
});
const capture = {
  captureId: 'cap-1',
  capturedAt: '2026-10-11T00:00:00Z',
  page,
  element: {
    tagName: 'p',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: 'SECRET-ELEMENT-TEXT',
    selector: 'p',
    rect: null,
  },
  screenshot: { viewport: 'data:image/png;base64,SECRETPNG', element: null },
  consoleIssues: [],
};
const conversation = (overrides: Record<string, unknown> = {}) =>
  ChatConversationSchema.parse({
    conversationId: 'session-1',
    generation: 'g1',
    seq: 1,
    threadId: null,
    turnId: null,
    state: 'running',
    messages: [
      { id: 'm1', role: 'user', text: 'SECRET-USER-MESSAGE' },
      { id: 'm2', role: 'assistant', text: 'SECRET-ASSISTANT-MESSAGE' },
    ],
    toolExecutions: [],
    warnings: [],
    cleanupPending: false,
    error: null,
    ...overrides,
  });
const session = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
  sessionId,
  resourceId: `${sessionId}-res`,
  title: sessionId,
  draft: 'SECRET-DRAFT',
  conversation: conversation(),
  context: capture,
  contextTarget: null,
  taskTargetRef: null,
  contextApplicability: 'current',
  taskVersions: [],
  ...overrides,
});
const run = (runId: string, overrides: Record<string, unknown> = {}): WorkbenchRun =>
  ({
    runId,
    workspaceId: WS,
    sessionId: 's1',
    taskVersionId: 'tv1',
    targetRef: null,
    state: 'running',
    startedAt: '2026-10-11T00:00:00Z',
    endedAt: null,
    error: null,
    candidateId: 'cand-1',
    validation: { state: 'not_run', applicability: 'current', reason: null },
    conversation: null,
    executionBinding: null,
    review: null,
    ...overrides,
  }) as WorkbenchRun;
const observation = (requestId: string, overrides: Record<string, unknown> = {}): ObservationRecord =>
  ObservationRecordSchema.parse({
    request: {
      requestId,
      workspaceId: WS,
      sessionId: 's1',
      runId: null,
      target: null,
      tool: 'files.list',
      args: {},
    },
    state: 'completed',
    startedAt: '2026-10-11T00:00:00.000Z',
    endedAt: '2026-10-11T00:00:01.000Z',
    result: null,
    evidenceRef: null,
    ...overrides,
  });
const observed = (status: 'complete' | 'partial' | 'unknown', reasons?: string[]) => ({
  resource: { workspaceId: WS, environmentId: 'local', resourceId: 'f1', kind: 'file', instanceId: 'fi', instanceGeneration: 1 },
  generation: 'g',
  revision: { value: 'v', strength: 'content-hash' },
  snapshotId: '11111111-1111-4111-8111-111111111111',
  capturedAt: '2026-10-11T00:00:00.000Z',
  source: 'disk',
  representation: 'text',
  coverage: { status, ...(reasons ? { reasons } : {}) },
  data: { text: 'SECRET-FILE-CONTENT' },
});

interface WorkspaceOverrides {
  resources?: unknown[];
  sessions?: unknown[];
  runs?: unknown[];
  observations?: unknown[];
  fileHints?: unknown[];
  managedApp?: unknown;
  app?: unknown;
}
const environment = (environmentId: 'local' | 'sandbox' | 'ssh', overrides: Record<string, unknown> = {}) => ({
  environmentId,
  kind: environmentId,
  label: environmentId,
  state: 'configured',
  reason: null,
  capabilities: { files: true, terminal: true, browser: true },
  ...overrides,
});
const snapshot = (workspace: WorkspaceOverrides = {}, top: Record<string, unknown> = {}): WorkbenchSnapshot =>
  WorkbenchSnapshotSchema.parse({
    appInstanceId: 'app-inst',
    environments: [environment('local'), environment('sandbox'), environment('ssh')],
    storageError: null,
    activeWorkspaceId: WS,
    seq: 1,
    workspaces: [
      {
        workspaceId: WS,
        name: 'ws',
        revision: 1,
        tabs: [],
        layout: { kind: 'pane', paneId: 'pane', tabId: null },
        activePaneId: 'pane',
        theme: 'light',
        resources: [],
        sessions: [],
        runs: [],
        ...workspace,
      },
    ],
    ...top,
  });
const input = (partial: Partial<FactInput> = {}): FactInput => ({ snapshot: null, chat: null, setup: null, execution: null, ...partial });
const factsOf = (workspace: WorkspaceOverrides = {}, top: Record<string, unknown> = {}) =>
  projectFacts(input({ snapshot: snapshot(workspace, top) }));
const find = (facts: StatusFact[], key: string) => facts.find((fact) => fact.key === key);
/** 每次投影都会带上的环境事实（对话读取中、尚未创建 App）；比较 key 列表时忽略，专门的用例单独断言它们。 */
const isAmbient = (fact: StatusFact) => fact.key === 'chat:global:state' || fact.label === '尚未创建 App';
const keys = (facts: StatusFact[]) => facts.filter((fact) => !isAmbient(fact)).map((fact) => fact.key);
const setup = (overrides: Record<string, unknown> = {}) =>
  SetupSnapshotSchema.parse({
    schemaVersion: 1,
    stage: 'ready',
    busy: false,
    error: null,
    pendingLogin: null,
    modelCredentialsConfigured: true,
    modelConnectionVerified: false,
    config: { schemaVersion: 1, sbxBinary: null, sandbox: null, pythonBinary: '/usr/bin/python3', localRoot: null, ssh: null },
    restartRequired: false,
    ...overrides,
  });
const execution = (overrides: Partial<ExecutionStatus> = {}): ExecutionStatus => ({
  available: false,
  reason: '固定比赛执行与验收服务（T04）尚未接入。',
  harness: { name: 'Codex CLI', state: 'integrated', version: null, model: null },
  ...overrides,
});

/* ---------- §4.1 全局 ---------- */

describe('projectFacts: 全局事实', () => {
  it('chat 三种情形：读取中、可用、不可用', () => {
    const pending = find(projectFacts(input()), 'chat:global:state')!;
    expect(pending).toMatchObject({ phase: 'pending', kind: 'steady', label: '正在读取对话状态' });
    const chat: ChatStatus = { available: true, reason: null, version: '0.160.0', sandbox: 'sbx-1', cwd: '/work' };
    expect(find(projectFacts(input({ chat })), 'chat:global:state')).toMatchObject({
      phase: 'ok',
      kind: 'steady',
      label: '对话可用',
      detail: '0.160.0 · sbx-1 · /work',
    });
    const down = find(projectFacts(input({ chat: { ...chat, available: false, reason: '沙箱未启动' } })), 'chat:global:state')!;
    expect(down).toMatchObject({
      phase: 'failed',
      kind: 'problem',
      label: '对话不可用',
      detail: '沙箱未启动',
      action: { id: 'nav.settings', label: '查看设置' },
    });
  });

  it('setup：未就绪、出错、等待登录、需重启各有自己的 key', () => {
    expect(keys(projectFacts(input({ setup: setup() })))).toEqual([]);
    const all = projectFacts(
      input({
        setup: setup({
          stage: 'sbx',
          error: { code: 'E_SBX', message: '安装失败' },
          pendingLogin: { id: '22222222-2222-4222-8222-222222222222', provider: 'openai' },
          restartRequired: true,
        }),
      }),
    );
    expect(keys(all)).toEqual(['setup:global:state', 'setup:global:error', 'setup:global:login', 'setup:global:restart']);
    expect(find(all, 'setup:global:state')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      label: '比赛环境未就绪',
      action: { id: 'nav.setup', label: '打开安装' },
    });
    expect(find(all, 'setup:global:error')).toMatchObject({ phase: 'failed', kind: 'problem', label: '环境安装出错', detail: '安装失败' });
    expect(find(all, 'setup:global:login')).toMatchObject({ phase: 'active', kind: 'progress', label: '等待 OpenAI 登录完成' });
    expect(find(all, 'setup:global:login')!.instanceToken).toBe('22222222-2222-4222-8222-222222222222');
    expect(find(all, 'setup:global:restart')).toMatchObject({ phase: 'degraded', kind: 'problem', label: '设置已保存，重启后生效' });
  });

  it('storage：持久化失败带原文并说明只保留在内存中', () => {
    const fact = find(factsOf({}, { storageError: '磁盘已满' }), 'storage:global:state')!;
    expect(fact).toMatchObject({
      phase: 'failed',
      kind: 'problem',
      label: '持久化失败：磁盘已满。当前状态仅保留在内存中',
      raw: {},
    });
    expect(find(factsOf(), 'storage:global:state')).toBeUndefined();
  });

  it('ExecutionStatus 任意输入只产出一条 capability，无动作，从不产出 problem', () => {
    const reasons = [null, '', '固定比赛执行与验收服务（T04）尚未接入。', 'x'.repeat(2000)];
    for (const available of [true, false])
      for (const reason of reasons)
        for (const state of ['not_integrated', 'integrated', 'unverified', 'verified'] as const) {
          const facts = projectFacts(
            input({ execution: execution({ available, reason, harness: { name: 'Codex CLI', state, version: '1', model: 'm' } }) }),
          );
          const capability = facts.filter((fact) => fact.domain === 'execution');
          expect(capability).toHaveLength(1);
          expect(facts.every((fact) => fact.kind !== 'problem')).toBe(true);
          expect(capability[0]).toMatchObject({
            key: 'execution:global:state',
            domain: 'execution',
            facet: 'state',
            phase: 'idle',
            kind: 'capability',
            label: '比赛执行与验收（T04）：尚未接入',
            raw: { available, harnessState: state },
          });
          expect(capability[0]!.action).toBeUndefined();
        }
    expect(keys(projectFacts(input({ execution: null })))).toEqual([]);
  });
});

/* ---------- §4.2 终端 ---------- */

describe('projectFacts: 终端', () => {
  const terminalFact = (terminal: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    factsOf({ resources: [resource('t1', { kind: 'terminal', terminal, ...extra })] });

  it('每个 state 都有映射：phase / kind / label / 动作', () => {
    const expected = {
      idle: ['idle', 'steady', '尚未连接', '连接终端'],
      starting: ['pending', 'progress', '正在连接…', undefined],
      running: ['ok', 'steady', '已连接', undefined],
      closing: ['pending', 'progress', '正在关闭并核实进程…', undefined],
      closed: ['idle', 'confirmation', '已关闭，所属进程已确认退出', '连接终端'],
      failed: ['failed', 'problem', '连接失败', '连接终端'],
    } as const;
    for (const [state, [phase, kind, label, action]] of Object.entries(expected)) {
      const fact = find(terminalFact(terminalState({ state })), 'terminal:t1:state')!;
      expect(fact, state).toMatchObject({ domain: 'terminal', facet: 'state', phase, kind, label });
      expect(fact.action?.label).toBe(action);
    }
  });

  it('尚未打开（terminal 为 null）视为 idle；running 的 detail 为沙箱全名与绝对 cwd；failed 的 detail 为 error', () => {
    expect(find(terminalFact(null), 'terminal:t1:state')).toMatchObject({ phase: 'idle', label: '尚未连接' });
    expect(find(terminalFact(terminalState()), 'terminal:t1:state')!.detail).toBe('sandbox-abc · /work/project');
    expect(find(terminalFact(terminalState({ state: 'failed', error: '连接被拒绝' })), 'terminal:t1:state')!.detail).toBe('连接被拒绝');
  });

  it('ssh 资源同样产出终端事实', () => {
    const facts = factsOf({ resources: [resource('ssh1', { kind: 'ssh', environmentId: 'ssh', terminal: terminalState() })] });
    expect(keys(facts)).toContain('terminal:ssh1:state');
  });

  it('cleanupPending 且进程应已结束（failed / closed / idle）才产出 unresolved，此时连接动作 disabled', () => {
    const facts = terminalFact(terminalState({ state: 'failed', cleanupPending: true, error: 'SSH 已断开' }));
    expect(find(facts, 'terminal:t1:cleanup')).toMatchObject({ phase: 'unknown', kind: 'unresolved', label: '所属进程退出未确认' });
    expect(find(facts, 'terminal:t1:state')!.action).toEqual({ id: 'terminal.connect', label: '连接终端', disabled: true });
    const clean = find(terminalFact(terminalState({ state: 'closed' })), 'terminal:t1:state')!;
    expect(clean.action).toEqual({ id: 'terminal.connect', label: '连接终端' });
    for (const state of ['closed', 'idle'] as const) {
      const pending = terminalFact(terminalState({ state, cleanupPending: true }));
      expect(find(pending, 'terminal:t1:cleanup')).toMatchObject({ phase: 'unknown', kind: 'unresolved' });
      expect(find(pending, 'terminal:t1:state')!.action).toEqual({ id: 'terminal.connect', label: '连接终端', disabled: true });
    }
  });

  it('cleanupPending 恢复为 false 后连接动作重新可用；starting / closing 不提供连接动作（由 busy 防重复）', () => {
    for (const state of ['failed', 'closed', 'idle'] as const) {
      const facts = terminalFact(terminalState({ state, cleanupPending: false, error: state === 'failed' ? 'x' : null }));
      expect(find(facts, 'terminal:t1:cleanup')).toBeUndefined();
      expect(find(facts, 'terminal:t1:state')!.action, state).toEqual({ id: 'terminal.connect', label: '连接终端' });
    }
    for (const state of ['starting', 'closing'] as const) {
      const facts = terminalFact(terminalState({ state, cleanupPending: true }));
      expect(find(facts, 'terminal:t1:state')!.action, state).toBeUndefined();
      expect(find(facts, 'terminal:t1:cleanup')).toBeUndefined();
    }
  });

  it('starting / running / closing 期间 PTY 本来就持有进程：cleanupPending 不产出 cleanup 事实，由 state 文案表达', () => {
    for (const state of ['starting', 'running', 'closing'] as const) {
      const facts = terminalFact(terminalState({ state, cleanupPending: true }));
      expect(keys(facts)).toEqual(['terminal:t1:state']);
    }
    expect(find(terminalFact(terminalState({ state: 'running', cleanupPending: true })), 'terminal:t1:state')).toMatchObject({
      phase: 'ok',
      kind: 'steady',
      label: '已连接',
    });
    expect(find(terminalFact(terminalState({ state: 'closing', cleanupPending: true })), 'terminal:t1:state')).toMatchObject({
      phase: 'pending',
      kind: 'progress',
    });
  });

  it('SSH 断线后 failed + cleanupPending：cleanup 为 unresolved，连接动作 disabled', () => {
    const facts = factsOf({
      resources: [
        resource('ssh1', {
          kind: 'ssh',
          environmentId: 'ssh',
          terminal: terminalState({ state: 'failed', cleanupPending: true, error: 'SSH 已断开' }),
        }),
      ],
    });
    expect(find(facts, 'terminal:ssh1:cleanup')).toMatchObject({ phase: 'unknown', kind: 'unresolved', label: '所属进程退出未确认' });
    expect(find(facts, 'terminal:ssh1:state')).toMatchObject({
      phase: 'failed',
      action: { id: 'terminal.connect', label: '连接终端', disabled: true },
    });
  });

  it('unavailableReason 产出 problem；instanceToken = instanceId:sessionId', () => {
    const facts = terminalFact(terminalState(), { unavailableReason: '环境未配置' });
    expect(find(facts, 'terminal:t1:unavailable')).toMatchObject({ phase: 'degraded', kind: 'problem', label: '环境未配置' });
    expect(find(facts, 'terminal:t1:state')!.instanceToken).toBe('t1-inst:pty-1');
    expect(find(terminalFact(null), 'terminal:t1:state')!.instanceToken).toBe('t1-inst:none');
  });

  it('不可用推导：资源原因优先；环境无终端能力取环境原因；环境缺失给通用说明；有能力则无事实', () => {
    const unavailable = (resourceOverrides: Record<string, unknown>, environments: unknown[]) =>
      find(
        factsOf({ resources: [resource('t1', { kind: 'terminal', terminal: null, ...resourceOverrides })] }, { environments }),
        'terminal:t1:unavailable',
      );
    const noTerminal = (reason: string | null) =>
      environment('local', { state: 'unavailable', reason, capabilities: { files: true, terminal: false, browser: true } });
    // 资源自带原因优先于环境原因。
    expect(unavailable({ unavailableReason: '资源原因' }, [noTerminal('环境原因')])).toMatchObject({ label: '资源原因', kind: 'problem' });
    // 环境没有终端能力：取环境 reason。
    expect(unavailable({}, [noTerminal('沙箱未配置')])).toMatchObject({ phase: 'degraded', kind: 'problem', label: '沙箱未配置' });
    // 环境没有 reason，或根本没有对应环境 / 资源未绑定环境：通用说明。
    expect(unavailable({}, [noTerminal(null)])!.label).toBe('环境能力尚未核对或终端未配置');
    expect(unavailable({}, [])!.label).toBe('环境能力尚未核对或终端未配置');
    expect(unavailable({ environmentId: null }, [environment('local')])!.label).toBe('环境能力尚未核对或终端未配置');
    expect(unavailable({ environmentId: 'sandbox' }, [environment('local')])!.label).toBe('环境能力尚未核对或终端未配置');
    // 有终端能力：没有该事实。
    expect(unavailable({}, [environment('local')])).toBeUndefined();
    // SSH 资源同一规则。
    const ssh = factsOf(
      { resources: [resource('s1', { kind: 'ssh', environmentId: 'ssh', terminal: null })] },
      { environments: [environment('ssh', { capabilities: { files: true, terminal: false, browser: false }, reason: 'SSH 未配置' })] },
    );
    expect(find(ssh, 'terminal:s1:unavailable')).toMatchObject({ label: 'SSH 未配置' });
  });

  it('实例或 PTY 会话更换后 instanceToken 变化', () => {
    const token = (instanceId: string, sessionId: string) =>
      find(terminalFact(terminalState({ sessionId }), { instanceId }), 'terminal:t1:state')!.instanceToken;
    expect(token('a', 's1')).not.toBe(token('b', 's1'));
    expect(token('a', 's1')).not.toBe(token('a', 's2'));
  });

  it('三个 facet 同时成立时 key 两两不同；任一消失只影响自己', () => {
    const full = terminalFact(terminalState({ state: 'failed', cleanupPending: true }), { unavailableReason: 'x' });
    expect(keys(full)).toEqual(['terminal:t1:state', 'terminal:t1:cleanup', 'terminal:t1:unavailable']);
    expect(new Set(keys(full)).size).toBe(3);
    const noCleanup = terminalFact(terminalState({ state: 'failed', cleanupPending: false }), { unavailableReason: 'x' });
    expect(keys(noCleanup)).toEqual(['terminal:t1:state', 'terminal:t1:unavailable']);
    const noReason = terminalFact(terminalState({ state: 'failed', cleanupPending: true }));
    expect(keys(noReason)).toEqual(['terminal:t1:state', 'terminal:t1:cleanup']);
  });
});

/* ---------- §4.3 网页 ---------- */

describe('projectFacts: 网页', () => {
  const full = {
    loading: true,
    picking: true,
    cdp: { state: 'detached', reason: '连接关闭' },
    consoleIssueCount: 4,
    loadError: { code: -105, description: 'NAME_NOT_RESOLVED', url: 'https://example.com/?q=SECRET' },
    blockedNavigation: 'https://blocked.example/path?secret=1#frag',
    pickError: '元素不可见',
    agentControl: { state: 'active', runId: 'r1', since: null, lastAction: '点击登录' },
  };
  const webFacts = (preview: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    factsOf({ resources: [resource('w1', { preview: preview && previewState(preview), ...extra })] });
  const allNine = [
    'web:w1:agent-control',
    'web:w1:picking',
    'web:w1:load-error',
    'web:w1:pick-error',
    'web:w1:blocked-nav',
    'web:w1:cdp',
    'web:w1:unavailable',
    'web:w1:state',
    'web:w1:console',
  ];

  it('9 个 facet 全部成立时 key 两两不同', () => {
    const facts = webFacts(full, { unavailableReason: '资源暂不可用' });
    expect(keys(facts).sort()).toEqual([...allNine].sort());
    expect(new Set(keys(facts)).size).toBe(9);
  });

  it('任一 facet 消失只影响自己的 key', () => {
    const removals: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['web:w1:agent-control', { agentControl: undefined }, {}],
      ['web:w1:picking', { picking: false }, {}],
      ['web:w1:load-error', { loadError: null }, {}],
      ['web:w1:pick-error', { pickError: null }, {}],
      ['web:w1:blocked-nav', { blockedNavigation: null }, {}],
      ['web:w1:cdp', { cdp: { state: 'attached' } }, {}],
      ['web:w1:unavailable', {}, { unavailableReason: null }],
      ['web:w1:state', { loading: false }, {}],
      ['web:w1:console', { consoleIssueCount: 0 }, {}],
    ];
    for (const [removed, previewPatch, resourcePatch] of removals) {
      const facts = webFacts({ ...full, ...previewPatch }, { unavailableReason: '资源暂不可用', ...resourcePatch });
      expect(keys(facts).sort(), removed).toEqual(allNine.filter((key) => key !== removed).sort());
    }
  });

  it('映射：文案、phase、kind、动作逐字符合设计', () => {
    const facts = webFacts(full, { unavailableReason: '资源暂不可用' });
    expect(find(facts, 'web:w1:agent-control')).toMatchObject({
      phase: 'active',
      kind: 'control',
      label: 'AI 正在操控此页面（点击登录）。你在页面中点击或输入会立即暂停 AI',
    });
    expect(find(facts, 'web:w1:picking')).toMatchObject({
      phase: 'active',
      kind: 'progress',
      label: '选择中 · Esc 取消',
      action: { id: 'web.cancelPick', label: '取消选择' },
    });
    expect(find(facts, 'web:w1:load-error')).toMatchObject({
      phase: 'failed',
      kind: 'problem',
      label: '页面加载失败：NAME_NOT_RESOLVED',
      action: { id: 'web.reload', label: '重新加载' },
    });
    expect(find(facts, 'web:w1:pick-error')).toMatchObject({ phase: 'failed', kind: 'problem', label: '元素选择失败：元素不可见' });
    expect(find(facts, 'web:w1:blocked-nav')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      label: '已拦截导航：https://blocked.example/path',
    });
    expect(find(facts, 'web:w1:cdp')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      label: '页面控制已断开',
      action: { id: 'web.reattach', label: '重新附着' },
    });
    expect(find(facts, 'web:w1:unavailable')).toMatchObject({ phase: 'degraded', kind: 'problem', label: '资源暂不可用' });
    expect(find(facts, 'web:w1:state')).toMatchObject({ phase: 'active', kind: 'steady', label: '正在加载' });
    expect(find(facts, 'web:w1:console')).toMatchObject({ phase: 'degraded', kind: 'steady', label: '页面有 4 条错误或警告' });
  });

  it('AI 暂停是 control，并提供「允许 AI 继续」；idle 不产出', () => {
    const paused = webFacts({ agentControl: { state: 'paused_by_user', runId: 'r1', since: null, lastAction: null } });
    expect(find(paused, 'web:w1:agent-control')).toMatchObject({
      phase: 'degraded',
      kind: 'control',
      label: '已暂停 AI 操控：检测到你在页面中的操作',
      action: { id: 'web.resumeAgent', label: '允许 AI 继续' },
    });
    expect(keys(webFacts({ agentControl: { state: 'idle', runId: null, since: null, lastAction: null } }))).toEqual([]);
    expect(keys(webFacts({}))).toEqual([]);
  });

  it('problem 内优先级：load-error > pick-error > cdp > blocked-nav > unavailable', () => {
    const facts = webFacts(full, { unavailableReason: '资源暂不可用' });
    const order = ['load-error', 'pick-error', 'cdp', 'blocked-nav', 'unavailable'].map(
      (facet) => find(facts, `web:w1:${facet}`)!.priority,
    );
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(new Set(order).size).toBe(order.length);
  });

  it('instanceToken = instanceId:documentGeneration，页面代次或实例变化后变化', () => {
    const token = (generation: number, instanceId = 'w1-inst') =>
      find(
        factsOf({
          resources: [
            resource('w1', {
              instanceId,
              preview: previewState({
                page: { ...page, documentGeneration: generation },
                loadError: { code: 1, description: 'x', url: 'u' },
              }),
            }),
          ],
        }),
        'web:w1:load-error',
      )!.instanceToken;
    expect(token(3)).toBe('w1-inst:3');
    expect(token(4)).not.toBe(token(3));
    expect(token(3, 'other')).not.toBe(token(3));
  });

  it('预览为 null 但 unavailableReason 成立时仍产出 unavailable', () => {
    const facts = webFacts(null, { unavailableReason: '正在恢复网页…', instanceId: null });
    expect(keys(facts)).toEqual(['web:w1:unavailable']);
    expect(find(facts, 'web:w1:unavailable')!.instanceToken).toBe('none:none');
  });
});

/* ---------- §4.4 受管 App ---------- */

describe('projectFacts: 受管 App', () => {
  const managedApp = (overrides: Record<string, unknown> = {}) => ({
    workspaceId: WS,
    projectId: '33333333-3333-4333-8333-333333333333',
    environmentId: 'sandbox',
    appInstanceId: 'app-1',
    state: 'running',
    url: null,
    guestCwd: '/work',
    guestPort: 3000,
    error: null,
    cleanupConfirmed: true,
    ...overrides,
  });

  it('无 managedApp：尚未创建 App，动作为新建 App', () => {
    const fact = find(factsOf(), `app:${WS}:state`)!;
    expect(fact).toMatchObject({
      phase: 'idle',
      kind: 'steady',
      label: '尚未创建 App',
      action: { id: 'app.create', label: '新建 App' },
      scope: { kind: 'workspace', workspaceId: WS },
    });
  });

  it('每个 state 都有映射', () => {
    const expected = {
      created: ['idle', 'steady', '已创建', '启动应用'],
      starting: ['pending', 'progress', '正在启动应用…', undefined],
      running: ['ok', 'steady', '服务运行中', undefined],
      stopping: ['pending', 'progress', '正在停止应用…', undefined],
      stopped: ['idle', 'steady', '已停止', '启动应用'],
      failed: ['failed', 'problem', '应用运行失败', '管理 App'],
    } as const;
    for (const [state, [phase, kind, label, action]] of Object.entries(expected)) {
      const fact = find(
        factsOf({ managedApp: managedApp({ state, error: state === 'failed' ? '端口被占用' : null }) }),
        `app:${WS}:state`,
      )!;
      expect(fact, state).toMatchObject({ phase, kind, label });
      expect(fact.action?.label).toBe(action);
      if (state === 'failed') expect(fact.detail).toBe('端口被占用');
    }
  });

  it('failed 或 stopped 且 cleanupConfirmed:false 才产出 cleanup(unresolved，常驻)；其余状态与已确认不产出', () => {
    for (const state of ['failed', 'stopped']) {
      const facts = factsOf({ managedApp: managedApp({ state, cleanupConfirmed: false }) });
      expect(keys(facts), state).toEqual([`app:${WS}:state`, `app:${WS}:cleanup`]);
      expect(find(facts, `app:${WS}:cleanup`), state).toMatchObject({
        phase: 'unknown',
        kind: 'unresolved',
        priority: 80,
        label: '应用进程清理未确认',
      });
      expect(keys(factsOf({ managedApp: managedApp({ state, cleanupConfirmed: true }) })), state).toEqual([`app:${WS}:state`]);
    }
    for (const state of ['created', 'starting', 'running', 'stopping'])
      expect(keys(factsOf({ managedApp: managedApp({ state, cleanupConfirmed: false }) })), state).toEqual([`app:${WS}:state`]);
  });

  it('instanceToken 为 appInstanceId', () => {
    expect(find(factsOf({ managedApp: managedApp() }), `app:${WS}:state`)!.instanceToken).toBe('app-1');
  });
});

/* ---------- §4.5 / §4.6 运行、检查、审阅 ---------- */

describe('projectFacts: 运行', () => {
  const runFacts = (overrides: Record<string, unknown>) => factsOf({ runs: [run('r1', overrides)] });

  it('每个 state 都有映射', () => {
    const expected = {
      starting: ['pending', 'progress', '正在启动…', '取消回复'],
      running: ['active', 'progress', '正在执行…', '取消回复'],
      cancelling: ['pending', 'progress', '正在取消并核实退出…', undefined],
      completed: ['ok', 'steady', '执行完成', undefined],
      cancelled: ['idle', 'steady', '已取消', undefined],
      failed: ['failed', 'problem', '执行失败', undefined],
      interrupted: ['failed', 'problem', '执行中断', undefined],
    } as const;
    for (const [state, [phase, kind, label, action]] of Object.entries(expected)) {
      const fact = find(runFacts({ state, error: state === 'failed' ? '模型异常' : null }), 'run:r1:state')!;
      expect(fact, state).toMatchObject({
        domain: 'run',
        phase,
        kind,
        label,
        instanceToken: 'r1',
        scope: { kind: 'session', workspaceId: WS, sessionId: 's1' },
      });
      expect(fact.action?.label).toBe(action);
      if (state === 'failed') expect(fact.detail).toBe('模型异常');
    }
  });

  it('cancelling 与 app-cleanup 同时成立时两条都产出', () => {
    const facts = runFacts({
      state: 'cancelling',
      appCleanupPending: true,
      executorState: { state: 'cancelled', cleanupPending: false },
    });
    expect(find(facts, 'run:r1:state')).toMatchObject({ label: '正在取消并核实退出…', kind: 'progress' });
    expect(find(facts, 'run:r1:app-cleanup')).toMatchObject({
      phase: 'unknown',
      kind: 'unresolved',
      label: '模型已停止，App 数据操作仍待确认',
    });
  });

  it('app-cleanup 只要 appCleanupPending 就产出；executorState 已确认无待清理时用「模型已停止」文案', () => {
    const fact = (overrides: Record<string, unknown>) => find(runFacts({ state: 'cancelling', ...overrides }), 'run:r1:app-cleanup');
    const stopped = fact({ appCleanupPending: true, executorState: { state: 'cancelled', cleanupPending: false } });
    expect(stopped).toMatchObject({ phase: 'unknown', kind: 'unresolved', label: '模型已停止，App 数据操作仍待确认' });
    // 执行器仍待清理
    expect(fact({ appCleanupPending: true, executorState: { state: 'cancelling', cleanupPending: true } })).toMatchObject({
      phase: 'unknown',
      kind: 'unresolved',
      label: 'App 数据操作结果待确认',
    });
    // 重启恢复路径：executorState 缺失
    expect(fact({ appCleanupPending: true })).toMatchObject({ phase: 'unknown', kind: 'unresolved', label: 'App 数据操作结果待确认' });
    // 未设置 appCleanupPending 时不产出
    expect(fact({ appCleanupPending: false, executorState: { state: 'cancelled', cleanupPending: false } })).toBeUndefined();
    expect(fact({ executorState: { state: 'cancelled', cleanupPending: false } })).toBeUndefined();
    expect(fact({})).toBeUndefined();
  });

  it('重新核对：cleanupRetryAvailable 时出现，cleanupReconciling 时 disabled', () => {
    const base = { state: 'cancelling', appCleanupPending: true, executorState: { state: 'cancelled', cleanupPending: false } };
    const action = (overrides: Record<string, unknown>) => find(runFacts({ ...base, ...overrides }), 'run:r1:app-cleanup')!.action;
    expect(action({})).toBeUndefined();
    expect(action({ cleanupRetryAvailable: false })).toBeUndefined();
    expect(action({ cleanupRetryAvailable: true })).toEqual({ id: 'run.reconcileCleanup', label: '重新核对' });
    expect(action({ cleanupRetryAvailable: true, cleanupReconciling: false })).toEqual({ id: 'run.reconcileCleanup', label: '重新核对' });
    expect(action({ cleanupRetryAvailable: true, cleanupReconciling: true })).toEqual({
      id: 'run.reconcileCleanup',
      label: '重新核对',
      disabled: true,
    });
  });

  it('cleanupPending 且 run 已进入终态才产出 process-cleanup(unresolved)；三条 run facet 同时成立时 key 两两不同', () => {
    const facts = runFacts({
      state: 'failed',
      cleanupPending: true,
      appCleanupPending: true,
      executorState: { state: 'cancelled', cleanupPending: false },
    });
    expect(find(facts, 'run:r1:process-cleanup')).toMatchObject({ phase: 'unknown', kind: 'unresolved', label: '正在核实所属进程退出…' });
    const runKeys = keys(facts).filter((key) => key.startsWith('run:'));
    expect(runKeys).toEqual(['run:r1:state', 'run:r1:process-cleanup', 'run:r1:app-cleanup']);
    expect(new Set(runKeys).size).toBe(3);
    for (const state of ['completed', 'cancelled', 'interrupted'] as const)
      expect(find(runFacts({ state, cleanupPending: true }), 'run:r1:process-cleanup')).toMatchObject({ kind: 'unresolved' });
  });

  it('starting / running / cancelling 期间进程本来就在：cleanupPending 不产出 process-cleanup，app-cleanup 规则不变', () => {
    for (const state of ['starting', 'running', 'cancelling'] as const) {
      const facts = runFacts({ state, cleanupPending: true });
      expect(find(facts, 'run:r1:process-cleanup')).toBeUndefined();
      expect(keys(facts).filter((key) => key.startsWith('run:'))).toEqual(['run:r1:state']);
    }
    const cancelling = runFacts({
      state: 'cancelling',
      cleanupPending: true,
      appCleanupPending: true,
      executorState: { state: 'cancelled', cleanupPending: false },
    });
    expect(keys(cancelling).filter((key) => key.startsWith('run:'))).toEqual(['run:r1:state', 'run:r1:app-cleanup']);
  });
});

describe('projectFacts: 检查与审阅', () => {
  const validation = (state: string, applicability: string, reason: string | null = null, review: unknown = null) =>
    factsOf({ runs: [run('r1', { validation: { state, applicability, reason }, review })] });

  it('每个 validation.state 都有映射', () => {
    const expected = {
      not_run: ['idle', 'steady', '尚未检查'],
      running: ['active', 'progress', '正在检查…'],
      passed: ['ok', 'steady', '检查通过'],
      failed: ['failed', 'problem', '检查未通过'],
      blocked: ['degraded', 'problem', '检查无法执行'],
    } as const;
    for (const [state, [phase, kind, label]] of Object.entries(expected)) {
      const fact = find(validation(state, 'current', '原因'), 'validation:r1:state')!;
      expect(fact, state).toMatchObject({ domain: 'validation', phase, kind, label });
      expect(fact.detail).toBe(state === 'failed' || state === 'blocked' ? '原因' : undefined);
    }
  });

  it('applicability：current 不产出；stale 为 problem；unknown 为 steady', () => {
    expect(find(validation('passed', 'current'), 'validation:r1:applicability')).toBeUndefined();
    expect(find(validation('passed', 'stale'), 'validation:r1:applicability')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      label: '检查已不适用于当前版本',
    });
    expect(find(validation('passed', 'unknown'), 'validation:r1:applicability')).toMatchObject({
      phase: 'unknown',
      kind: 'steady',
      label: '检查适用性未知',
    });
  });

  it('review：null / accepted / changes_requested', () => {
    const review = (decision: 'accepted' | 'changes_requested' | null) =>
      find(
        validation('passed', 'current', null, decision && { decision, reviewedAt: '2026-10-11T00:00:00Z', candidateId: 'cand-1' }),
        'review:r1:state',
      )!;
    expect(review(null)).toMatchObject({ phase: 'idle', kind: 'steady', label: '尚未审阅', raw: { decision: null } });
    expect(review('accepted')).toMatchObject({ phase: 'ok', kind: 'steady', label: '已接受', raw: { decision: 'accepted' } });
    expect(review('changes_requested')).toMatchObject({ phase: 'idle', kind: 'steady', label: '已要求修改' });
  });

  it('validation 两个 facet 同时成立时 key 不同', () => {
    const facts = validation('failed', 'stale', '错误');
    expect(keys(facts).filter((key) => key.startsWith('validation:'))).toEqual(['validation:r1:state', 'validation:r1:applicability']);
  });
});

/* ---------- §4.7 会话上下文 ---------- */

describe('projectFacts: 会话上下文', () => {
  const contextFacts = (overrides: Record<string, unknown>) => factsOf({ sessions: [session('s1', overrides)] });

  it('applicability 三种取值', () => {
    expect(find(contextFacts({ contextApplicability: 'current' }), 'context:s1:applicability')).toMatchObject({
      phase: 'ok',
      kind: 'steady',
      label: '现场适用性：有效',
    });
    expect(find(contextFacts({ contextApplicability: 'stale' }), 'context:s1:applicability')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      label: '现场适用性：已失效',
      action: { id: 'context.recapture', label: '重新选择元素' },
    });
    expect(find(contextFacts({ contextApplicability: 'unknown' }), 'context:s1:applicability')).toMatchObject({
      phase: 'unknown',
      kind: 'steady',
      label: '现场适用性：未知',
    });
  });

  it('capture：pending 为 progress 且可取消；failed 为 problem；完成与取消不产出', () => {
    const request = (state: string, error: string | null = null) => ({ requestId: 'req-1', resourceId: 'w1', state, error });
    expect(find(contextFacts({ captureRequest: request('pending') }), 'context:s1:capture')).toMatchObject({
      phase: 'active',
      kind: 'progress',
      label: '正在采集…',
      action: { id: 'web.cancelPick', label: '取消采集' },
    });
    expect(find(contextFacts({ captureRequest: request('failed', '页面已关闭') }), 'context:s1:capture')).toMatchObject({
      phase: 'failed',
      kind: 'problem',
      label: '采集失败',
      detail: '页面已关闭',
    });
    expect(find(contextFacts({ captureRequest: request('completed') }), 'context:s1:capture')).toBeUndefined();
    expect(find(contextFacts({ captureRequest: request('cancelled') }), 'context:s1:capture')).toBeUndefined();
  });

  it('historyRestored 为 confirmation；三个 facet 同时成立时 key 两两不同', () => {
    const facts = contextFacts({
      contextApplicability: 'stale',
      historyRestored: true,
      captureRequest: { requestId: 'req-1', resourceId: 'w1', state: 'pending', error: null },
    });
    expect(find(facts, 'context:s1:history-restored')).toMatchObject({
      phase: 'degraded',
      kind: 'confirmation',
      label: '历史已恢复；新执行不会自动延续旧模型上下文。',
    });
    expect(keys(facts)).toEqual(['context:s1:applicability', 'context:s1:capture', 'context:s1:history-restored']);
  });

  it('instanceToken = sessionId:captureRequest.requestId，重新采集后变化', () => {
    const token = (requestId?: string) =>
      find(
        contextFacts(requestId ? { captureRequest: { requestId, resourceId: 'w1', state: 'completed', error: null } } : {}),
        'context:s1:applicability',
      )!.instanceToken;
    expect(token('req-1')).toBe('s1:req-1');
    expect(token()).toBe('s1:none');
    expect(token('req-2')).not.toBe(token('req-1'));
  });

  it('history-restored 的 instanceToken 只取 sessionId：requestId 变化时不变，applicability 的 token 变化', () => {
    const tokens = (requestId: string) => {
      const facts = contextFacts({
        historyRestored: true,
        captureRequest: { requestId, resourceId: 'w1', state: 'completed', error: null },
      });
      return {
        restored: find(facts, 'context:s1:history-restored')!.instanceToken,
        applicability: find(facts, 'context:s1:applicability')!.instanceToken,
        capture: find(
          contextFacts({ captureRequest: { requestId, resourceId: 'w1', state: 'pending', error: null } }),
          'context:s1:capture',
        )!.instanceToken,
      };
    };
    const first = tokens('req-1');
    const second = tokens('req-2');
    expect(first.restored).toBe('s1');
    expect(second.restored).toBe(first.restored);
    expect(second.applicability).not.toBe(first.applicability);
    expect(first.applicability).toBe('s1:req-1');
    expect(first.capture).toBe('s1:req-1');
  });
});

/* ---------- §4.8 观察与文件 ---------- */

describe('projectFacts: 观察与文件', () => {
  const obsFacts = (record: ObservationRecord) => factsOf({ sessions: [session('s1', { observations: [record] })] });

  it('pending 为 progress 且可取消', () => {
    expect(find(obsFacts(observation('o1', { state: 'pending', endedAt: null })), 'observation:o1:state')).toMatchObject({
      phase: 'active',
      kind: 'progress',
      label: '正在读取…',
      action: { id: 'observation.cancel', label: '取消读取' },
      scope: { kind: 'session', workspaceId: WS, sessionId: 's1' },
    });
  });

  it('failed：每个错误码都有标签', () => {
    const expected = {
      unsupported: '不支持',
      unauthorized: '未获授权',
      unavailable: '不可用',
      not_found: '未找到',
      stale_cursor: '续读已失效',
      stale_ref: '引用已失效',
      gap: '输出有缺口',
      invalid_request: '输入无效',
      timeout: '读取超时',
      unstable: '内容不稳定',
      cancelled: '已取消',
      budget_exceeded: '超出读取预算',
    } as const;
    for (const [error, label] of Object.entries(expected)) {
      const fact = find(obsFacts(observation('o1', { state: 'failed', result: { error, message: '细节' } })), 'observation:o1:state')!;
      expect(fact, error).toMatchObject({
        phase: 'failed',
        kind: 'problem',
        label: `读取失败：${label}`,
        detail: '细节',
        raw: { errorCode: error },
      });
    }
  });

  it('completed / cancelled 不产出 state；completed 且有覆盖信息时产出 coverage', () => {
    expect(
      find(obsFacts(observation('o1', { state: 'cancelled', result: { error: 'cancelled', message: 'x' } })), 'observation:o1:state'),
    ).toBeUndefined();
    const cases = {
      complete: ['ok', 'steady', '覆盖完整'],
      partial: ['degraded', 'problem', '覆盖不完整'],
      unknown: ['unknown', 'problem', '覆盖情况未知'],
    } as const;
    for (const [status, [phase, kind, label]] of Object.entries(cases)) {
      const facts = obsFacts(
        observation('o1', { result: observed(status as 'complete', status === 'partial' ? ['目录过深', '权限不足'] : undefined) }),
      );
      expect(find(facts, 'observation:o1:state')).toBeUndefined();
      const fact = find(facts, 'observation:o1:coverage')!;
      expect(fact, status).toMatchObject({ phase, kind, label, raw: { coverageStatus: status, revisionStrength: 'content-hash' } });
      expect(fact.detail).toBe(status === 'partial' ? '目录过深、权限不足' : undefined);
    }
  });

  it('文件级记录（无会话）按目标资源或空间归属；state 与 coverage 同时成立时 key 不同', () => {
    const request = { requestId: 'o2', workspaceId: WS, sessionId: null, runId: null, target: null, tool: 'files.list', args: {} };
    const record = ObservationRecordSchema.parse({
      request,
      state: 'pending',
      startedAt: '2026-10-11T00:00:00.000Z',
      endedAt: null,
      result: observed('partial'),
      evidenceRef: null,
    });
    const facts = factsOf({ observations: [record] });
    expect(keys(facts)).toEqual(['observation:o2:state', 'observation:o2:coverage']);
    expect(find(facts, 'observation:o2:state')!.scope).toEqual({ kind: 'workspace', workspaceId: WS });
  });

  it('文件资源不可用：未绑定环境或带 unavailableReason 产出 file:<id>:unavailable；健康文件不产出', () => {
    const fileFacts = (overrides: Record<string, unknown>) => factsOf({ resources: [resource('f1', { kind: 'file', ...overrides })] });
    expect(find(fileFacts({ environmentId: null }), 'file:f1:unavailable')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      priority: 60,
      label: '此资源没有授权环境，请新建标签并明确选择已配置环境。',
      scope: { kind: 'resource', workspaceId: WS, resourceId: 'f1' },
      instanceToken: 'f1-inst:1',
      raw: {},
    });
    const empty = find(fileFacts({ environmentId: null, unavailableReason: '' }), 'file:f1:unavailable')!;
    expect(empty.label).toBe('此资源没有授权环境，请新建标签并明确选择已配置环境。');
    expect(StatusFactSchema.safeParse(empty).success).toBe(true);
    expect(find(fileFacts({ unavailableReason: '授权根已移除' }), 'file:f1:unavailable')).toMatchObject({
      phase: 'degraded',
      kind: 'problem',
      label: '授权根已移除',
    });
    expect(find(fileFacts({}), 'file:f1:unavailable')).toBeUndefined();
  });

  it('file:unavailable 与 file:hint 同存时 key 两两不同，互不压制', () => {
    const hint = {
      workspaceId: WS,
      environmentId: 'local',
      resourceId: 'f1',
      kind: 'file',
      instanceId: 'fi',
      instanceGeneration: 1,
      generation: 'g',
      watchGeneration: 1,
      sequence: 1,
      capturedAt: '2026-10-11T00:00:00.000Z',
      change: 'change',
      coverage: { scope: 'observed-directories', recursive: false, lossy: true },
    };
    const facts = factsOf({
      resources: [resource('f1', { kind: 'file', unavailableReason: '授权根已移除' })],
      fileHints: [hint],
    });
    expect(
      keys(facts)
        .filter((key) => key.startsWith('file:'))
        .sort(),
    ).toEqual(['file:f1:hint', 'file:f1:unavailable']);
  });

  it('文件变化提示：每个 change 都有标签', () => {
    const expected = {
      change: '内容已变化',
      rename: '已重命名',
      delete: '已删除',
      unknown: '变化未知',
      root_replaced: '根目录被替换',
      closed: '已关闭',
    } as const;
    for (const [change, label] of Object.entries(expected)) {
      const hint = {
        workspaceId: WS,
        environmentId: 'local',
        resourceId: 'f1',
        kind: 'file',
        instanceId: 'fi',
        instanceGeneration: 2,
        generation: 'g',
        watchGeneration: 5,
        sequence: 1,
        capturedAt: '2026-10-11T00:00:00.000Z',
        change,
        coverage: { scope: 'observed-directories', recursive: false, lossy: true },
      };
      const fact = find(factsOf({ fileHints: [hint] }), 'file:f1:hint')!;
      expect(fact, change).toMatchObject({
        phase: 'degraded',
        kind: 'problem',
        label: `文件可能变化 · ${label}；请重新读取`,
        scope: { kind: 'resource', workspaceId: WS, resourceId: 'f1' },
        instanceToken: 'fi:2:5',
        raw: { change },
      });
    }
  });
});

/* ---------- 全局不变量 ---------- */

describe('projectFacts: 键、raw 白名单、限制与纯度', () => {
  const maximal = () => {
    const chat: ChatStatus = { available: false, reason: '沙箱未启动', version: null, sandbox: null, cwd: null };
    return input({
      chat,
      execution: execution(),
      setup: setup({
        stage: 'sbx',
        error: { code: 'E', message: 'm' },
        pendingLogin: { id: '22222222-2222-4222-8222-222222222222', provider: 'docker' },
        restartRequired: true,
      }),
      snapshot: snapshot(
        {
          managedApp: {
            workspaceId: WS,
            projectId: '33333333-3333-4333-8333-333333333333',
            environmentId: 'sandbox',
            appInstanceId: 'app-1',
            state: 'stopped',
            url: null,
            guestCwd: '/work',
            error: null,
            cleanupConfirmed: false,
          },
          resources: [
            resource('w1', {
              unavailableReason: '资源暂不可用',
              preview: previewState({
                loading: true,
                picking: true,
                cdp: { state: 'detached', reason: 'x' },
                consoleIssueCount: 2,
                loadError: { code: 1, description: 'd', url: 'u' },
                blockedNavigation: 'https://b.example/?q=1',
                pickError: 'e',
                agentControl: { state: 'paused_by_user', runId: null, since: null, lastAction: null },
              }),
            }),
            resource('t1', {
              kind: 'terminal',
              unavailableReason: '环境未配置',
              terminal: terminalState({ state: 'failed', cleanupPending: true, error: 'e' }),
            }),
          ],
          sessions: [
            session('s1', {
              historyRestored: true,
              contextApplicability: 'stale',
              captureRequest: { requestId: 'req-1', resourceId: 'w1', state: 'pending', error: null },
              observations: [observation('o1', { state: 'pending', endedAt: null, result: observed('partial') })],
            }),
          ],
          runs: [
            run('r1', {
              state: 'cancelling',
              cleanupPending: true,
              appCleanupPending: true,
              cleanupRetryAvailable: true,
              executorState: { state: 'cancelled', cleanupPending: false },
              validation: { state: 'failed', applicability: 'stale', reason: 'r' },
              review: { decision: 'accepted', reviewedAt: '2026-10-11T00:00:00Z', candidateId: 'cand-1' },
            }),
          ],
          fileHints: [
            {
              workspaceId: WS,
              environmentId: 'local',
              resourceId: 'f1',
              kind: 'file',
              instanceId: 'fi',
              instanceGeneration: 1,
              generation: 'g',
              watchGeneration: 1,
              sequence: 1,
              capturedAt: '2026-10-11T00:00:00.000Z',
              change: 'change',
              coverage: { scope: 'observed-directories', recursive: false, lossy: true },
            },
          ],
        },
        { storageError: '磁盘已满' },
      ),
    });
  };

  it('所有 domain 的所有 facet 同时成立时，全局 key 两两不同且 key 与 domain / facet 一致', () => {
    const facts = projectFacts(maximal());
    const all = facts.map((fact) => fact.key);
    expect(all.filter((key, index) => all.indexOf(key) !== index)).toEqual([]);
    const domains = new Set(facts.map((fact) => fact.domain));
    expect([...domains].sort()).toEqual(
      [
        'app',
        'chat',
        'context',
        'execution',
        'file',
        'observation',
        'review',
        'run',
        'setup',
        'storage',
        'terminal',
        'validation',
        'web',
      ].sort(),
    );
    for (const fact of facts) expect(fact.key.startsWith(`${fact.domain}:`) && fact.key.endsWith(`:${fact.facet}`), fact.key).toBe(true);
  });

  it('每条事实都通过协议 schema 校验，raw 只含白名单字段', () => {
    for (const fact of projectFacts(maximal())) {
      expect(StatusFactSchema.safeParse(fact).success, fact.key).toBe(true);
      const allowed = Object.keys(StatusRawSchemas[fact.domain].shape);
      expect(
        Object.keys(fact.raw).every((key) => allowed.includes(key)),
        fact.key,
      ).toBe(true);
    }
    expect(StatusRawSchemas.web.safeParse({ instanceId: 'a', screenshot: 'x' }).success).toBe(false);
    expect(StatusRawSchemas.terminal.safeParse({ state: 'running', output: 'x' }).success).toBe(false);
    expect(StatusFactSchema.safeParse({ ...projectFacts(maximal())[0], domain: 'web' }).success).toBe(false);
  });

  it('PageCapture、终端输出、消息正文、草稿、文件内容与 URL 查询串不出现在任何事实中', () => {
    const facts = projectFacts(maximal());
    const dump = JSON.stringify(facts);
    for (const secret of [
      'SECRETPNG',
      'SECRET-ELEMENT-TEXT',
      'SECRET-TERMINAL-OUTPUT',
      'SECRET-USER-MESSAGE',
      'SECRET-ASSISTANT-MESSAGE',
      'SECRET-DRAFT',
      'SECRET-FILE-CONTENT',
      'token=SECRET',
      'q=1',
      '#frag',
    ])
      expect(dump, secret).not.toContain(secret);
    expect(facts.length).toBeGreaterThan(0);
  });

  it('label ≤120、detail ≤300 字符', () => {
    const facts = projectFacts(
      input({
        chat: { available: false, reason: 'r'.repeat(1000), version: null, sandbox: null, cwd: null },
        snapshot: snapshot(
          {
            resources: [
              resource('w1', {
                unavailableReason: 'u'.repeat(1000),
                preview: previewState({
                  loadError: { code: 1, description: 'd'.repeat(1000), url: 'u' },
                  agentControl: { state: 'active', runId: null, since: null, lastAction: 'a'.repeat(200) },
                }),
              }),
            ],
          },
          { storageError: 's'.repeat(1000) },
        ),
      }),
    );
    expect(facts.length).toBeGreaterThan(4);
    for (const fact of facts) {
      expect(fact.label.length, fact.key).toBeLessThanOrEqual(120);
      expect((fact.detail ?? '').length, fact.key).toBeLessThanOrEqual(300);
    }
    // 插值被截断时，固定尾句仍保留
    expect(find(facts, 'storage:global:state')!.label.endsWith('。当前状态仅保留在内存中')).toBe(true);
    expect(find(facts, 'web:w1:agent-control')!.label.endsWith('会立即暂停 AI')).toBe(true);
    expect(find(facts, 'web:w1:unavailable')!.detail).toHaveLength(300);
  });

  it('单条 raw 序列化超过 2 KiB 时截断并标 truncated: true', () => {
    const fact = find(
      factsOf({ resources: [resource('t1', { kind: 'terminal', terminal: terminalState({ sessionId: 's'.repeat(5000) }) })] }),
      'terminal:t1:state',
    )!;
    expect(fact.raw).toMatchObject({ truncated: true, state: 'running' });
    expect(new TextEncoder().encode(JSON.stringify(fact.raw)).length).toBeLessThanOrEqual(2048);
    const small = find(factsOf({ resources: [resource('t1', { kind: 'terminal', terminal: terminalState() })] }), 'terminal:t1:state')!;
    expect(small.raw).not.toHaveProperty('truncated');
  });

  it('凭据先脱敏再截断：横跨 detail 截断边界的 sk- token 不留下残片', () => {
    const token = `sk-${'AbCd1234'.repeat(8)}`;
    const detail = `${'x'.repeat(285)} ${token} ${'y'.repeat(50)}`;
    const facts = projectFacts(input({ chat: { available: false, reason: detail, version: null, sandbox: null, cwd: null } }));
    const fact = find(facts, 'chat:global:state')!;
    expect(fact.detail).not.toMatch(/sk-/);
    expect(fact.detail!.length).toBeLessThanOrEqual(300);
    expect(fact.detail!.startsWith(`${'x'.repeat(285)} [redacted] yy`)).toBe(true);
    // 插值进 label 的值同样先脱敏
    const label = find(factsOf({}, { storageError: `${'x'.repeat(60)} ${token}` }), 'storage:global:state')!.label;
    expect(label).not.toMatch(/sk-/);
  });

  it('raw 校验失败时降级为 { truncated: true }，不抛异常', () => {
    const value = snapshot({ resources: [resource('t1', { kind: 'terminal', terminal: terminalState() })] });
    value.workspaces[0]!.resources[0]!.terminal!.outputOffset = 1.5; // 绕过快照 schema，模拟脏数据
    const facts = projectFacts(input({ snapshot: value }));
    const fact = find(facts, 'terminal:t1:state')!;
    expect(fact.raw).toEqual({ truncated: true });
    expect(StatusFactSchema.safeParse(fact).success).toBe(true);
    expect(fact.label).toBe('已连接');
  });

  it('纯函数：相同输入得到相同输出，且不修改输入', () => {
    const value = maximal();
    const before = JSON.stringify(value);
    const first = projectFacts(value);
    expect(JSON.stringify(value)).toBe(before);
    expect(projectFacts(value)).toEqual(first);
  });

  it('全空输入只产出 chat 读取中', () => {
    expect(projectFacts(input()).map((fact) => fact.key)).toEqual(['chat:global:state']);
  });
});

it('disables maintenance status actions across workspaces while verification recovery is unconfirmed', () => {
  const facts = factsOf(
    {},
    { eduVerification: { status: null, original: null, target: null, urls: [], recoveryRequired: true, error: null } },
  );
  const create = facts.find((fact) => fact.action?.id === 'app.create');
  expect(create?.action?.disabled).toBe(true);
  expect(factsOf().find((fact) => fact.action?.id === 'app.create')?.action?.disabled).not.toBe(true);
});
