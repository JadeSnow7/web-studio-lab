import { beforeEach, describe, expect, it } from 'vitest';
import type { StatusFact, StatusKind, StatusScope, WorkbenchSnapshot } from '@wsl/protocol';
import { projectFacts } from '../../../shared/status';
import { dismissError, reportError } from './errors';
import { workspaceStore } from './workspace';
import {
  EMPTY_PRESENTATION,
  GAP_LABEL,
  HISTORY_CONTEXT_LABEL,
  HISTORY_UNAVAILABLE_LABEL,
  TOAST_LIMIT,
  ackScope,
  startStatusPresentationSync,
  deriveStatus,
  derivedStatus,
  groupForScope,
  presentStatus,
  presentToasts,
  scopeKey,
  statusPresentationActions as actions,
  terminalToken,
  statusPresentationStore as store,
  type Hint,
  type PresentationState,
  type StatusView,
} from './status-view';

const WS = 'ws';
const resource = (resourceId: string): StatusScope => ({ kind: 'resource', workspaceId: WS, resourceId });
const session = (sessionId: string): StatusScope => ({ kind: 'session', workspaceId: WS, sessionId });
const GLOBAL: StatusScope = { kind: 'global' };

interface FactSpec {
  domain: StatusFact['domain'];
  entity: string;
  facet: string;
  scope: StatusScope;
  kind: StatusKind;
  priority?: number;
  label?: string;
  token?: string;
  phase?: StatusFact['phase'];
  raw?: Record<string, unknown>;
}
/** 直接构造事实：presentStatus 只读事实的公共字段，raw 的内容与本层无关。 */
function fact(spec: FactSpec): StatusFact {
  return {
    key: `${spec.domain}:${spec.entity}:${spec.facet}`,
    domain: spec.domain,
    facet: spec.facet,
    scope: spec.scope,
    phase: spec.phase ?? 'degraded',
    kind: spec.kind,
    priority: spec.priority ?? 10,
    label: spec.label ?? `${spec.domain}:${spec.entity}:${spec.facet}`,
    instanceToken: spec.token ?? 'token-1',
    raw: spec.raw ?? {},
  } as StatusFact;
}
const generic = (entity: string, facet: string, scope: StatusScope, kind: StatusKind, priority = 10, token = 'token-1') =>
  fact({ domain: 'web', entity, facet, scope, kind, priority, token });

const present = (facts: StatusFact[], state: Partial<PresentationState> = {}, snapshot?: WorkbenchSnapshot) =>
  presentStatus(facts, { ...EMPTY_PRESENTATION, ...state }, { snapshot: snapshot ?? null });
const find = (views: readonly StatusView[], key: string) => {
  const view = views.find((v) => v.key === key);
  if (!view) throw new Error(`缺少视图 ${key}`);
  return view;
};
const forScope = (views: readonly StatusView[], scope: StatusScope) =>
  groupForScope(views.filter((v) => scopeKey(v.scope) === scopeKey(scope)));

beforeEach(() => store.set(() => EMPTY_PRESENTATION));

describe('通道分配', () => {
  const R = resource('web-1');

  it('control / unresolved / progress 全部进常驻通道，顺序 control > unresolved > progress，同类按 priority 降序', () => {
    const facts = [
      generic('web-1', 'picking', R, 'progress', 65),
      generic('web-1', 'load', R, 'progress', 50),
      generic('web-1', 'cleanup', R, 'unresolved', 90),
      generic('web-1', 'agent-control', R, 'control', 100),
    ];
    const group = forScope(present(facts), R);
    expect(group.persistent.map((v) => v.facet)).toEqual(['agent-control', 'cleanup', 'picking', 'load']);
    expect(group.persistent.every((v) => v.channel === 'persistent' && v.visible)).toBe(true);
  });

  it('常驻通道不受 problem 数量影响，也不因交互降级', () => {
    const persistent = [generic('web-1', 'agent-control', R, 'control', 100), generic('web-1', 'cleanup', R, 'unresolved', 90)];
    const problems = Array.from({ length: 12 }, (_, i) => generic('web-1', `problem-${i}`, R, 'problem', 10 + i));
    const state: Partial<PresentationState> = {
      acks: Object.fromEntries([...persistent, ...problems].map((f) => [f.key, f.instanceToken])),
    };
    const group = forScope(present([...persistent, ...problems], state), R);
    expect(group.persistent).toHaveLength(2);
    expect(group.persistent.every((v) => v.visible)).toBe(true);
    // 用户交互（ackFacts）不影响 unresolved / control。
    actions.ackFacts(R, persistent);
    expect(store.get().acks).toEqual({});
    expect(forScope(present(persistent), R).persistent).toHaveLength(2);
  });

  it('problem 每个 scope 只有 1 条可见，其余进「另有 N 项」，且按 priority 降序', () => {
    const A = resource('a');
    const B = resource('b');
    const facts = [
      generic('a', 'low', A, 'problem', 10),
      generic('a', 'high', A, 'problem', 50),
      generic('a', 'mid', A, 'problem', 30),
      generic('b', 'only', B, 'problem', 5),
      generic('b', 'second', B, 'problem', 4),
    ];
    const views = present(facts);
    const a = forScope(views, A);
    expect(a.problem?.facet).toBe('high');
    expect(a.more.map((v) => v.facet)).toEqual(['mid', 'low']);
    expect(views.filter((v) => v.channel === 'problem' && v.visible && scopeKey(v.scope) === scopeKey(A))).toHaveLength(1);
    const b = forScope(views, B);
    expect(b.problem?.facet).toBe('only');
    expect(b.more.map((v) => v.facet)).toEqual(['second']);
  });

  it('steady → ambient，capability → settings；capability 从不进 toast / persistent / problem', () => {
    const views = present([
      generic('web-1', 'state', R, 'steady'),
      fact({ domain: 'execution', entity: 'global', facet: 'state', scope: GLOBAL, kind: 'capability', priority: 0 }),
    ]);
    expect(find(views, 'web:web-1:state').channel).toBe('ambient');
    const capability = find(views, 'execution:global:state');
    expect(capability.channel).toBe('settings');
    expect(forScope(views, GLOBAL)).toMatchObject({ persistent: [], problem: null, notice: null });
    expect(presentToasts(views, EMPTY_PRESENTATION)).toEqual([]);
  });

  it('全局 problem → toast，storage → banner；其余全局 kind 保持各自通道', () => {
    const views = present([
      fact({ domain: 'chat', entity: 'global', facet: 'state', scope: GLOBAL, kind: 'problem', priority: 80 }),
      fact({ domain: 'storage', entity: 'global', facet: 'state', scope: GLOBAL, kind: 'problem', priority: 90 }),
      fact({ domain: 'setup', entity: 'global', facet: 'login', scope: GLOBAL, kind: 'progress' }),
    ]);
    expect(find(views, 'chat:global:state')).toMatchObject({ channel: 'toast', visible: true });
    expect(find(views, 'storage:global:state')).toMatchObject({ channel: 'banner', visible: true });
    expect(find(views, 'setup:global:login').channel).toBe('persistent');
    // 无窗格归属的 problem 不进窗格的问题通道。
    expect(forScope(views, GLOBAL).problem).toBeNull();
    expect(presentToasts(views, EMPTY_PRESENTATION).map((t) => t.id)).toEqual(['status:chat:global:state']);
  });
});

describe('确认与提示（提示通道）', () => {
  const T = resource('term-1');
  const closed = (token: string) =>
    fact({ domain: 'terminal', entity: 'term-1', facet: 'state', scope: T, kind: 'confirmation', priority: 20, token });

  it('confirmation 被同一 instanceToken 确认后消失；token 变化后再次显示', () => {
    const first = closed('inst-1:pty-1');
    expect(forScope(present([first]), T).notice?.key).toBe('terminal:term-1:state');
    actions.ackFacts(T, [first]);
    expect(store.get().acks).toEqual({ 'terminal:term-1:state': 'inst-1:pty-1' });
    expect(forScope(present([first], store.get()), T).notice).toBeNull();
    // 重新连接再关闭：实例更换，token 变化，旧确认失效。
    expect(forScope(present([closed('inst-2:pty-2')], store.get()), T).notice?.key).toBe('terminal:term-1:state');
  });

  it('只确认本范围内的 confirmation', () => {
    const other = fact({ domain: 'terminal', entity: 'term-2', facet: 'state', scope: resource('term-2'), kind: 'confirmation' });
    actions.ackFacts(T, [closed('t'), other]);
    expect(Object.keys(store.get().acks)).toEqual(['terminal:term-1:state']);
  });

  it('同一 scope 同时只显示 1 条：hint 优先于 confirmation，较新的 hint 优先；关闭后下一条上来', () => {
    const hint = (name: string): Hint => ({ key: `ui:term-1:${name}`, scope: T, label: name, source: 'first-use', until: 'ack' });
    actions.hint(hint('a'));
    actions.hint(hint('b'));
    const views = present([closed('t')], store.get());
    const notices = views.filter((v) => v.channel === 'notice');
    expect(notices.map((v) => [v.key, v.visible])).toEqual([
      ['ui:term-1:b', true],
      ['ui:term-1:a', false],
      ['terminal:term-1:state', false],
    ]);
    expect(forScope(views, T).notice?.label).toBe('b');
    // 「知道了」只移除当前这条 hint，下一条上来。
    actions.acknowledge(T, find(views, 'ui:term-1:b'));
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:term-1:a']);
    expect(forScope(present([closed('t')], store.get()), T).notice?.key).toBe('ui:term-1:a');
    // 窗格交互（ackFacts）则清除该范围内全部 ack 型 hint（§6.2），再轮到 confirmation。
    actions.ackFacts(T, []);
    expect(store.get().hints).toEqual([]);
    expect(forScope(present([closed('t')], store.get()), T).notice?.key).toBe('terminal:term-1:state');
  });

  it('hint until:ack：关闭或窗格交互后清除；同 key 再次登记覆盖旧条目', () => {
    const h: Hint = { key: 'ui:term-1:x', scope: T, label: '一', source: 'bookmark', until: 'ack' };
    actions.hint(h);
    actions.hint({ ...h, label: '二' });
    expect(store.get().hints.map((x) => x.label)).toEqual(['二']);
    actions.ackFacts(resource('elsewhere'), []);
    expect(store.get().hints).toHaveLength(1);
    actions.ackFacts(T, []);
    expect(store.get().hints).toEqual([]);
    actions.hint(h);
    actions.dismissHint(h.key);
    expect(store.get().hints).toEqual([]);
  });

  it('hint until:navigation：交互不清除，切换空间时清除不属于新空间的', () => {
    const inWs = (workspaceId: string, name: string): Hint => ({
      key: `ui:${name}`,
      scope: { kind: 'resource', workspaceId, resourceId: 'r' },
      label: name,
      source: 'snapshot',
      until: 'navigation',
    });
    actions.hint(inWs('ws-1', 'one'));
    actions.hint(inWs('ws-2', 'two'));
    actions.hint({ key: 'ui:global', scope: GLOBAL, label: 'g', source: 'first-use', until: 'navigation' });
    actions.hint({ key: 'ui:keep', scope: inWs('ws-1', '').scope, label: 'k', source: 'first-use', until: 'ack' });
    actions.ackFacts(inWs('ws-1', '').scope, []);
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:one', 'ui:two', 'ui:global']);
    actions.clearNavigationHints('ws-2');
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:two']);
  });
});

/* ---------- 用 projectFacts 的真实输出验证组合场景 ---------- */

const web = (id: string, preview: Record<string, unknown>) => ({
  resourceId: id,
  kind: 'web',
  environmentId: 'local',
  title: id,
  url: null,
  instanceId: `${id}-inst`,
  generation: 1,
  preview: {
    page: { webContentsId: 1, documentGeneration: 1, url: 'https://example.com/', title: 't', partition: 'p' },
    loading: false,
    canGoBack: false,
    canGoForward: false,
    picking: false,
    cdp: { state: 'attached' },
    consoleIssueCount: 0,
    loadError: null,
    blockedNavigation: null,
    pickError: null,
    ...preview,
  },
  terminal: null,
  unavailableReason: null,
});
const runRecord = (runId: string, sessionId: string, overrides: Record<string, unknown> = {}) => ({
  runId,
  workspaceId: WS,
  sessionId,
  taskVersionId: 'tv1',
  targetRef: null,
  state: 'completed',
  startedAt: '2026-10-11T00:00:00Z',
  endedAt: null,
  error: null,
  candidateId: 'cand-1',
  validation: { state: 'not_run', applicability: 'current', reason: null },
  conversation: null,
  executionBinding: null,
  review: null,
  ...overrides,
});
const sessionRecord = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
  sessionId,
  resourceId: `${sessionId}-res`,
  title: sessionId,
  draft: '',
  conversation: null,
  context: null,
  contextTarget: null,
  taskTargetRef: null,
  contextApplicability: 'current',
  captureRequest: null,
  historyRestored: false,
  taskVersions: [],
  observations: [],
  ...overrides,
});
const snapshotOf = (overrides: {
  resources?: unknown[];
  sessions?: unknown[];
  runs?: unknown[];
  observations?: unknown[];
}): WorkbenchSnapshot =>
  ({
    appInstanceId: 'app-1',
    seq: 1,
    activeWorkspaceId: WS,
    storageError: null,
    workspaces: [
      {
        workspaceId: WS,
        app: null,
        managedApp: null,
        resources: [],
        sessions: [],
        runs: [],
        observations: [],
        fileHints: [],
        ...overrides,
      },
    ],
  }) as unknown as WorkbenchSnapshot;
const factsOf = (snapshot: WorkbenchSnapshot) => projectFacts({ snapshot, chat: null, setup: null, execution: null });

describe('组合场景', () => {
  it('AI 操控 + 加载失败 + 已拦截导航：control 常驻，加载失败为问题，拦截导航进「另有 1 项」', () => {
    const snapshot = snapshotOf({
      resources: [
        web('w1', {
          agentControl: { state: 'active', lastAction: '点击按钮' },
          loadError: { code: -105, description: 'NAME_NOT_RESOLVED' },
          blockedNavigation: 'https://evil.example/path?q=1',
        }),
      ],
    });
    const group = forScope(present(factsOf(snapshot), {}, snapshot), resource('w1'));
    expect(group.persistent.map((v) => v.facet)).toEqual(['agent-control']);
    expect(group.persistent[0]!.label).toContain('AI 正在操控此页面');
    expect(group.problem?.facet).toBe('load-error');
    expect(group.more.map((v) => v.facet)).toEqual(['blocked-nav']);
  });

  it('已暂停 AI + 页面控制断开：「允许 AI 继续」常驻，「重新附着」在问题通道，各自带动作', () => {
    const snapshot = snapshotOf({
      resources: [web('w1', { agentControl: { state: 'paused_by_user', lastAction: null }, cdp: { state: 'detached' } })],
    });
    const group = forScope(present(factsOf(snapshot), {}, snapshot), resource('w1'));
    expect(group.persistent.map((v) => v.action?.id)).toEqual(['web.resumeAgent']);
    expect(group.problem?.action?.id).toBe('web.reattach');
    expect(group.more).toEqual([]);
  });

  it('run cancelling + app-cleanup：两条都在常驻通道，cancelling 在 unresolved 之后', () => {
    const snapshot = snapshotOf({
      sessions: [sessionRecord('s1')],
      runs: [
        runRecord('r1', 's1', {
          state: 'cancelling',
          appCleanupPending: true,
          cleanupRetryAvailable: true,
          executorState: { state: 'cancelled', cleanupPending: false },
        }),
      ],
    });
    const group = forScope(present(factsOf(snapshot), {}, snapshot), session('s1'));
    expect(group.persistent.map((v) => v.facet)).toEqual(['app-cleanup', 'state']);
    expect(group.persistent[0]!.label).toBe('模型已停止，App 数据操作仍待确认');
    expect(group.persistent[0]!.action).toMatchObject({ id: 'run.reconcileCleanup' });
    expect(group.persistent[1]!.label).toBe('正在取消并核实退出…');
  });

  it('SSH 进程退出未确认：交互（ackFacts）后仍然显示', () => {
    const T = resource('ssh-1');
    const cleanup = fact({ domain: 'terminal', entity: 'ssh-1', facet: 'cleanup', scope: T, kind: 'unresolved', priority: 90 });
    actions.ackFacts(T, [cleanup]);
    expect(forScope(present([cleanup], store.get()), T).persistent.map((v) => v.key)).toEqual(['terminal:ssh-1:cleanup']);
  });
});

describe('当前项限定', () => {
  it('历史 failed run 不进问题通道；最新 run 失败才进', () => {
    const S = session('s1');
    const snapshot = snapshotOf({
      sessions: [sessionRecord('s1')],
      runs: [runRecord('old', 's1', { state: 'failed', error: 'boom' }), runRecord('new', 's1', { state: 'completed' })],
    });
    const views = present(factsOf(snapshot), {}, snapshot);
    const group = forScope(views, S);
    expect(group.problem).toBeNull();
    expect(group.more).toEqual([]);
    const old = find(views, 'run:old:state');
    expect(old).toMatchObject({ channel: 'problem', visible: false, historical: true });
    expect(find(views, 'run:new:state').visible).toBe(true);

    const failedNow = snapshotOf({
      sessions: [sessionRecord('s1')],
      runs: [runRecord('old', 's1', { state: 'failed' }), runRecord('new', 's1', { state: 'failed', error: 'later' })],
    });
    const next = forScope(present(factsOf(failedNow), {}, failedNow), S);
    expect(next.problem?.key).toBe('run:new:state');
    expect(next.more).toEqual([]);
  });

  it('历史 run 的检查失败与审阅也只保留在列表中，不计入「另有 N 项」', () => {
    const snapshot = snapshotOf({
      sessions: [sessionRecord('s1')],
      runs: [
        runRecord('old', 's1', { validation: { state: 'failed', applicability: 'stale', reason: 'x' } }),
        runRecord('new', 's1', { validation: { state: 'passed', applicability: 'current', reason: null } }),
      ],
    });
    const views = present(factsOf(snapshot), {}, snapshot);
    const group = forScope(views, session('s1'));
    expect(group.problem).toBeNull();
    expect(group.more).toEqual([]);
    expect(views.filter((v) => v.historical).map((v) => v.key)).toEqual(
      expect.arrayContaining(['validation:old:state', 'validation:old:applicability', 'review:old:state', 'run:old:state']),
    );
  });

  it('persistent 类不受当前项限定：有历史选择时最新 run 的 progress 与 app-cleanup 仍常驻可见', () => {
    const S = session('s1');
    const snapshot = snapshotOf({
      sessions: [sessionRecord('s1')],
      runs: [
        runRecord('old', 's1', { state: 'completed' }),
        runRecord('new', 's1', {
          state: 'cancelling',
          appCleanupPending: true,
          cleanupRetryAvailable: true,
          executorState: { state: 'cancelled', cleanupPending: false },
        }),
      ],
    });
    actions.selectHistory('s1', { runId: 'old' });
    const views = present(factsOf(snapshot), store.get(), snapshot);
    const group = forScope(views, S);
    expect(group.persistent.map((v) => v.key)).toEqual(['run:new:app-cleanup', 'run:new:state']);
    expect(group.persistent.every((v) => v.channel === 'persistent' && v.visible && !v.historical)).toBe(true);
    // steady 仍按所选 run 限定。
    expect(find(views, 'run:new:state').visible).toBe(true);
    expect(group.ambient.map((v) => v.key)).toContain('run:old:state');
  });

  it('persistent 类不受当前项限定：新 run 存在时旧 run 上的 unresolved 仍常驻可见，旧 failed 仍隐藏', () => {
    const S = session('s1');
    const snapshot = snapshotOf({
      sessions: [sessionRecord('s1')],
      runs: [
        runRecord('old', 's1', { state: 'failed', error: 'boom', appCleanupPending: true, cleanupPending: true }),
        runRecord('new', 's1', { state: 'completed' }),
      ],
    });
    const views = present(factsOf(snapshot), {}, snapshot);
    const group = forScope(views, S);
    expect(group.persistent.map((v) => v.key)).toEqual(['run:old:app-cleanup', 'run:old:process-cleanup']);
    expect(group.persistent.every((v) => v.visible)).toBe(true);
    expect(group.problem).toBeNull();
    expect(group.more).toEqual([]);
    expect(find(views, 'run:old:state')).toMatchObject({ channel: 'problem', visible: false, historical: true });
  });

  it('旧的 failed 观察不进问题通道，每个 scope 只呈现最新一条', () => {
    const complete = {
      resource: { workspaceId: WS, environmentId: 'local', resourceId: 'f1', kind: 'file', instanceId: 'fi', instanceGeneration: 1 },
      generation: 'g',
      revision: { value: 'v', strength: 'content-hash' },
      snapshotId: '11111111-1111-4111-8111-111111111111',
      capturedAt: '2026-10-11T00:00:00.000Z',
      source: 'disk',
      representation: 'text',
      coverage: { status: 'complete' },
      data: {},
    };
    const record = (requestId: string, state: string) => ({
      request: { requestId, workspaceId: WS, sessionId: 's1', runId: null, target: null, tool: 'files.list', args: {} },
      state,
      startedAt: '2026-10-11T00:00:00.000Z',
      endedAt: '2026-10-11T00:00:01.000Z',
      result: state === 'failed' ? { error: 'timeout', message: 'm' } : complete,
    });
    const snapshot = snapshotOf({
      sessions: [sessionRecord('s1', { observations: [record('o-old', 'failed'), record('o-new', 'failed')] })],
    });
    const views = present(factsOf(snapshot), {}, snapshot);
    const group = forScope(views, session('s1'));
    expect(group.problem?.key).toBe('observation:o-new:state');
    expect(group.more).toEqual([]);
    expect(find(views, 'observation:o-old:state')).toMatchObject({ visible: false, historical: true });

    const recovered = snapshotOf({
      sessions: [sessionRecord('s1', { observations: [record('o-old', 'failed'), record('o-new', 'completed')] })],
    });
    expect(forScope(present(factsOf(recovered), {}, recovered), session('s1')).problem).toBeNull();
  });
});

describe('最新观察按记录判定', () => {
  const complete = {
    resource: { workspaceId: WS, environmentId: 'local', resourceId: 'f1', kind: 'file', instanceId: 'fi', instanceGeneration: 1 },
    generation: 'g',
    revision: { value: 'v', strength: 'content-hash' },
    snapshotId: '11111111-1111-4111-8111-111111111111',
    capturedAt: '2026-10-11T00:00:00.000Z',
    source: 'disk',
    representation: 'text',
    coverage: { status: 'complete' },
    data: {},
  };
  const record = (requestId: string, state: 'failed' | 'cancelled' | 'completed', startedAt: string, sessionId: string | null = 's1') => ({
    request: { requestId, workspaceId: WS, sessionId, runId: null, target: null, tool: 'files.list', args: {} },
    state,
    startedAt,
    endedAt: startedAt,
    result:
      state === 'failed' ? { error: 'timeout', message: 'm' } : state === 'cancelled' ? { error: 'cancelled', message: 'c' } : complete,
  });

  it('旧 failed + 新 cancelled（cancelled 不产出事实）：旧的失败不再进问题通道', () => {
    const snapshot = snapshotOf({
      sessions: [
        sessionRecord('s1', {
          observations: [record('o-old', 'failed', '2026-10-11T00:00:00.000Z'), record('o-new', 'cancelled', '2026-10-11T00:05:00.000Z')],
        }),
      ],
    });
    const views = present(factsOf(snapshot), {}, snapshot);
    expect(find(views, 'observation:o-old:state')).toMatchObject({ visible: false, historical: true });
    expect(forScope(views, session('s1')).problem).toBeNull();
  });

  it('以 startedAt 为准而不是数组顺序；并列时取靠后的一条', () => {
    const snapshot = snapshotOf({
      sessions: [
        sessionRecord('s1', {
          observations: [record('o-new', 'failed', '2026-10-11T00:05:00.000Z'), record('o-old', 'failed', '2026-10-11T00:00:00.000Z')],
        }),
      ],
    });
    expect(forScope(present(factsOf(snapshot), {}, snapshot), session('s1')).problem?.key).toBe('observation:o-new:state');
    const tied = snapshotOf({
      sessions: [
        sessionRecord('s1', {
          observations: [record('a', 'failed', '2026-10-11T00:00:00.000Z'), record('b', 'failed', '2026-10-11T00:00:00.000Z')],
        }),
      ],
    });
    expect(forScope(present(factsOf(tied), {}, tied), session('s1')).problem?.key).toBe('observation:b:state');
  });

  it('按 scope 分别判定：会话与空间级（无会话）互不影响；workspace 与 session 两处重复的 requestId 只算一次', () => {
    const snapshot = snapshotOf({
      observations: [record('w-old', 'failed', '2026-10-11T00:00:00.000Z', null)],
      sessions: [sessionRecord('s1', { observations: [record('s-fail', 'failed', '2026-10-11T00:01:00.000Z')] })],
    });
    const views = present(factsOf(snapshot), {}, snapshot);
    expect(forScope(views, { kind: 'workspace', workspaceId: WS }).problem?.key).toBe('observation:w-old:state');
    expect(forScope(views, session('s1')).problem?.key).toBe('observation:s-fail:state');
  });
});

describe('历史选择', () => {
  const S = session('s1');
  const snapshot = snapshotOf({
    sessions: [
      sessionRecord('s1', {
        contextApplicability: 'stale',
        taskVersions: [{ taskVersionId: 'tv1' }, { taskVersionId: 'tv2' }],
      }),
    ],
    runs: [
      runRecord('r1', 's1', { taskVersionId: 'tv1', state: 'failed', error: 'old' }),
      runRecord('r2', 's1', { taskVersionId: 'tv2', state: 'completed' }),
    ],
  });
  const facts = factsOf(snapshot);

  it('无选择：呈现最新 run；现场失效是问题', () => {
    const group = forScope(present(facts, {}, snapshot), S);
    expect(group.problem?.key).toBe('context:s1:applicability');
    expect(group.ambient.map((v) => v.key)).toContain('run:r2:state');
  });

  it('选择历史 run：只取所选 runId；现场适用性改写为历史采集并降为 steady', () => {
    actions.selectHistory('s1', { runId: 'r1' });
    const views = present(facts, store.get(), snapshot);
    const group = forScope(views, S);
    expect(group.problem?.key).toBe('run:r1:state');
    expect(find(views, 'run:r2:state')).toMatchObject({ visible: false, historical: true });
    const context = find(views, 'context:s1:applicability');
    expect(context).toMatchObject({ label: HISTORY_CONTEXT_LABEL, kind: 'steady', channel: 'ambient', visible: true });
    expect(context.action).toBeUndefined();
    expect(group.more).toEqual([]);
  });

  it('只选任务版本：取该版本的最新 run', () => {
    actions.selectHistory('s1', { taskVersionId: 'tv2' });
    const views = present(facts, store.get(), snapshot);
    expect(find(views, 'run:r2:state').visible).toBe(true);
    expect(find(views, 'run:r1:state').visible).toBe(false);
    expect(views.find((v) => v.facet === 'history-unavailable')).toBeUndefined();
  });

  it('版本选择取自快照而不是 raw：raw 降级为 { truncated: true } 也能按版本定位', () => {
    const degraded = facts.map((f) => (f.domain === 'run' ? ({ ...f, raw: { truncated: true } } as StatusFact) : f));
    actions.selectHistory('s1', { taskVersionId: 'tv1' });
    const views = present(degraded, store.get(), snapshot);
    expect(find(views, 'run:r1:state').visible).toBe(true);
    expect(find(views, 'run:r2:state').visible).toBe(false);
    expect(views.find((v) => v.facet === 'history-unavailable')).toBeUndefined();
  });

  it('所选 run 或版本已不在快照中：产出「指定历史记录已不可用」problem', () => {
    actions.selectHistory('s1', { runId: 'gone' });
    const missingRun = present(facts, store.get(), snapshot);
    expect(forScope(missingRun, S).problem).toMatchObject({
      key: 'ui:s1:history-unavailable',
      label: HISTORY_UNAVAILABLE_LABEL,
      channel: 'problem',
    });
    expect(HISTORY_UNAVAILABLE_LABEL).toBe('指定历史记录已不可用，请重新从任务历史定位。');
    expect(missingRun.filter((v) => v.domain === 'run').every((v) => !v.visible)).toBe(true);

    actions.selectHistory('s1', { taskVersionId: 'tv-gone' });
    expect(forScope(present(facts, store.get(), snapshot), S).problem?.key).toBe('ui:s1:history-unavailable');
  });

  it('清除选择后恢复；相同选择不产生新状态', () => {
    actions.selectHistory('s1', { runId: 'r1' });
    const once = store.get();
    actions.selectHistory('s1', { runId: 'r1' });
    expect(store.get()).toBe(once);
    actions.selectHistory('s1', null);
    expect(store.get().selections).toEqual({});
    actions.selectHistory('s1', null);
    expect(find(present(facts, store.get(), snapshot), 'run:r2:state').visible).toBe(true);
  });
});

describe('快照清理与终端输出缺口', () => {
  const snapshotWith = (sessions: string[], terminal?: { instanceId: string; sessionId: string }) =>
    snapshotOf({
      sessions: sessions.map((id) => sessionRecord(id)),
      resources: terminal
        ? [
            {
              resourceId: 'term-1',
              kind: 'terminal',
              environmentId: 'local',
              title: 't',
              url: null,
              instanceId: terminal.instanceId,
              generation: 1,
              preview: null,
              terminal: {
                seq: 1,
                sessionId: terminal.sessionId,
                sandbox: 'sb',
                cwd: '/w',
                state: 'running',
                output: '',
                outputOffset: 0,
                cleanupPending: false,
                error: null,
              },
              unavailableReason: null,
            },
          ]
        : [],
    });

  it('会话从快照消失时删除其 selections', () => {
    actions.selectHistory('s1', { runId: 'r1' });
    actions.selectHistory('s2', { runId: 'r2' });
    actions.pruneForSnapshot(snapshotWith(['s1', 's2']));
    expect(Object.keys(store.get().selections)).toEqual(['s1', 's2']);
    const before = store.get();
    actions.pruneForSnapshot(snapshotWith(['s1', 's2']));
    expect(store.get()).toBe(before);
    actions.pruneForSnapshot(snapshotWith(['s2']));
    expect(Object.keys(store.get().selections)).toEqual(['s2']);
  });

  it('终端实例或 PTY 会话变化时删除 terminalGaps；资源消失同样删除', () => {
    actions.setTerminalGap('term-1', { instanceId: 'inst-1', sessionId: 'pty-1' });
    actions.pruneForSnapshot(snapshotWith([], { instanceId: 'inst-1', sessionId: 'pty-1' }));
    expect(store.get().terminalGaps['term-1']).toEqual({ instanceId: 'inst-1', sessionId: 'pty-1' });
    actions.pruneForSnapshot(snapshotWith([], { instanceId: 'inst-1', sessionId: 'pty-2' }));
    expect(store.get().terminalGaps).toEqual({});

    actions.setTerminalGap('term-1', { instanceId: 'inst-1', sessionId: 'pty-2' });
    actions.pruneForSnapshot(snapshotWith([], { instanceId: 'inst-2', sessionId: 'pty-2' }));
    expect(store.get().terminalGaps).toEqual({});

    actions.setTerminalGap('term-1', { instanceId: 'inst-2', sessionId: 'pty-2' });
    actions.pruneForSnapshot(snapshotWith([]));
    expect(store.get().terminalGaps).toEqual({});
  });

  it('确认后同一 PTY 会话再次缺口会重新显示（setTerminalGap 清除对它的确认）；clearTerminalGap 同样清除', () => {
    const snapshot = snapshotWith([], { instanceId: 'inst-1', sessionId: 'pty-1' });
    const facts = factsOf(snapshot);
    const T = resource('term-1');
    const gap = { instanceId: 'inst-1', sessionId: 'pty-1' };
    actions.setTerminalGap('term-1', gap);
    actions.acknowledge(T, find(present(facts, store.get(), snapshot), 'ui:term-1:output-gap'));
    expect(forScope(present(facts, store.get(), snapshot), T).notice).toBeNull();
    actions.setTerminalGap('term-1', { ...gap });
    expect(forScope(present(facts, store.get(), snapshot), T).notice?.key).toBe('ui:term-1:output-gap');
    // 没有确认可清时保持原引用。
    const before = store.get();
    actions.setTerminalGap('term-1', { ...gap });
    expect(store.get()).toBe(before);
    actions.acknowledge(T, find(present(facts, store.get(), snapshot), 'ui:term-1:output-gap'));
    actions.clearTerminalGap('term-1');
    expect(store.get().acks).toEqual({});
    expect(store.get().terminalGaps).toEqual({});
  });

  it('缺口 token 与终端事实的 instanceToken 同一规则：null 记为 none', () => {
    expect(terminalToken(null, undefined)).toBe('none:none');
    const snapshot = snapshotWith([], { instanceId: 'inst-1', sessionId: 'pty-1' });
    const fact = factsOf(snapshot).find((f) => f.key === 'terminal:term-1:state')!;
    expect(fact.instanceToken).toBe(terminalToken('inst-1', 'pty-1'));
  });

  it('pruneForSnapshot 同时清理实体已消失的 acks 与 scope 已消失的 hints；global 保留；无变化时保持引用', () => {
    const snapshot = snapshotWith(['s1'], { instanceId: 'inst-1', sessionId: 'pty-1' });
    const hint = (key: string, scope: StatusScope): Hint => ({ key, scope, label: key, source: 'first-use', until: 'ack' });
    store.set((state) => ({
      ...state,
      acks: {
        'terminal:term-1:state': 't',
        'terminal:gone:state': 't',
        'context:s1:history-restored': 't',
        'context:s-gone:history-restored': 't',
        'run:r-gone:state': 't',
        'chat:global:state': 't',
        'ui:term-1:output-gap': 't',
        'ui:gone:output-gap': 't',
      },
    }));
    actions.hint(hint('ui:keep-res', resource('term-1')));
    actions.hint(hint('ui:keep-session', session('s1')));
    actions.hint(hint('ui:keep-global', GLOBAL));
    actions.hint(hint('ui:gone-res', resource('gone')));
    actions.hint(hint('ui:gone-session', session('s-gone')));
    actions.hint(hint('ui:gone-ws', { kind: 'workspace', workspaceId: 'nope' }));
    actions.pruneForSnapshot(snapshot);
    expect(Object.keys(store.get().acks).sort()).toEqual([
      'chat:global:state',
      'context:s1:history-restored',
      'terminal:term-1:state',
      'ui:term-1:output-gap',
    ]);
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:keep-res', 'ui:keep-session', 'ui:keep-global']);
    const settled = store.get();
    actions.pruneForSnapshot(snapshot);
    expect(store.get()).toBe(settled);
  });

  it('缺口作为 notice 显示，确认后消失；clearTerminalGap 移除', () => {
    const snapshot = snapshotWith([], { instanceId: 'inst-1', sessionId: 'pty-1' });
    const facts = factsOf(snapshot);
    const T = resource('term-1');
    actions.setTerminalGap('term-1', { instanceId: 'inst-1', sessionId: 'pty-1' });
    const views = present(facts, store.get(), snapshot);
    expect(forScope(views, T).notice).toMatchObject({ key: 'ui:term-1:output-gap', label: GAP_LABEL });
    actions.acknowledge(T, find(views, 'ui:term-1:output-gap'));
    expect(forScope(present(facts, store.get(), snapshot), T).notice).toBeNull();
    actions.clearTerminalGap('term-1');
    expect(store.get().terminalGaps).toEqual({});
    // 实例不匹配的缺口不显示。
    actions.setTerminalGap('term-1', { instanceId: 'other', sessionId: 'pty-1' });
    expect(present(facts, store.get(), snapshot).some((v) => v.key === 'ui:term-1:output-gap')).toBe(false);
  });
});

describe('Toast 队列与错误出口', () => {
  const chatProblem = fact({ domain: 'chat', entity: 'global', facet: 'state', scope: GLOBAL, kind: 'problem', priority: 80 });

  it('reportError / dismissError 保持原行为：去掉 invoke 前缀，最多 5 条', () => {
    reportError('读取', new Error("Error invoking remote method 'x:y': Error: 磁盘已满"));
    expect(store.get().uiErrors).toMatchObject([{ context: '读取', message: '磁盘已满' }]);
    for (let i = 0; i < 6; i++) reportError(`动作${i}`, `失败${i}`);
    expect(store.get().uiErrors).toHaveLength(5);
    expect(store.get().uiErrors.at(-1)).toMatchObject({ context: '动作5', message: '失败5' });
    const first = store.get().uiErrors[0]!;
    dismissError(first.id);
    expect(store.get().uiErrors.map((e) => e.id)).not.toContain(first.id);
  });

  it('合并 uiErrors 与 workspaceError，最多 5 条；超出时丢弃最早的错误，工作区错误保留', () => {
    for (let i = 0; i < 5; i++) actions.pushUiError(`c${i}`, `m${i}`);
    const toasts = presentToasts([], store.get(), { workspaceError: '最多四个窗格；请先关闭一个窗格。' });
    expect(toasts).toHaveLength(TOAST_LIMIT);
    expect(toasts.at(-1)).toMatchObject({ kind: 'workspace-error', message: '最多四个窗格；请先关闭一个窗格。' });
    expect(toasts.filter((t) => t.kind === 'ui-error').map((t) => (t.kind === 'ui-error' ? t.error.context : ''))).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
    expect(presentToasts([], EMPTY_PRESENTATION, { workspaceError: null })).toEqual([]);
  });

  it('全局 problem 在余位内进入队列，排在错误之后', () => {
    const views = present([chatProblem]);
    actions.pushUiError('a', 'b');
    const toasts = presentToasts(views, store.get(), { workspaceError: 'e' });
    expect(toasts.map((t) => t.kind)).toEqual(['ui-error', 'workspace-error', 'status']);
    for (let i = 0; i < 4; i++) actions.pushUiError('x', `${i}`);
    expect(presentToasts(views, store.get(), { workspaceError: 'e' }).every((t) => t.kind !== 'status')).toBe(true);
  });

  it('deriveStatus：toast、banner 与 settings 各取各的；依赖引用不变时复用结果', () => {
    const snapshot = { ...snapshotOf({}), storageError: '磁盘只读' } as WorkbenchSnapshot;
    const deps = {
      snapshot,
      chat: { available: false, reason: '未安装', version: null, sandbox: null, cwd: null },
      setup: null,
      execution: { available: false, reason: '未接入', harness: { state: 'unavailable' } } as never,
      presentation: EMPTY_PRESENTATION,
      workspaceError: '失败了',
    };
    const derived = deriveStatus(deps);
    expect(derived.banner?.key).toBe('storage:global:state');
    expect(derived.toasts.map((t) => t.kind)).toEqual(['workspace-error', 'status']);
    expect(derived.views.find((v) => v.domain === 'execution')?.channel).toBe('settings');
    expect(derivedStatus(deps)).toBe(derivedStatus({ ...deps }));
    expect(derivedStatus({ ...deps, workspaceError: null })).not.toBe(derivedStatus(deps));
  });
});

const terminalSnapshot = (state: string): WorkbenchSnapshot =>
  snapshotOf({
    resources: [
      {
        resourceId: 'term-1',
        kind: 'terminal',
        environmentId: 'local',
        title: 't',
        url: null,
        instanceId: 'inst-1',
        generation: 1,
        preview: null,
        terminal: {
          seq: 1,
          sessionId: 'pty-1',
          sandbox: 'sb',
          cwd: '/w',
          state,
          output: '',
          outputOffset: 0,
          cleanupPending: false,
          error: null,
        },
        unavailableReason: null,
      },
    ],
  });

describe('startStatusPresentationSync 与 ackScope', () => {
  const resetWorkspace = () => workspaceStore.set(() => ({ snapshot: null, selectedId: null, error: null }));
  beforeEach(resetWorkspace);

  const navHint = (workspaceId: string): Hint => ({
    key: `ui:${workspaceId}`,
    scope: { kind: 'resource', workspaceId, resourceId: 'r' },
    label: workspaceId,
    source: 'snapshot',
    until: 'navigation',
  });

  it('selectedId 变化触发 clearNavigationHints；返回的函数确实取消订阅', () => {
    actions.hint(navHint('ws-1'));
    actions.hint(navHint('ws-2'));
    const stop = startStatusPresentationSync();
    workspaceStore.set((s) => ({ ...s, selectedId: 'ws-1' }));
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:ws-1']);
    actions.hint(navHint('ws-2'));
    workspaceStore.set((s) => ({ ...s, selectedId: 'ws-2' }));
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:ws-2']);
    stop();
    actions.hint(navHint('ws-1'));
    workspaceStore.set((s) => ({ ...s, selectedId: 'ws-3' }));
    expect(store.get().hints.map((h) => h.key)).toEqual(['ui:ws-2', 'ui:ws-1']);
    resetWorkspace();
  });

  it('快照变化时 prune；快照引用未变（只是 selectedId / error 变化）时跳过', () => {
    const snapshot = snapshotOf({ sessions: [sessionRecord('s1')] });
    workspaceStore.set((s) => ({ ...s, snapshot, selectedId: WS }));
    const stop = startStatusPresentationSync();
    actions.selectHistory('s-gone', { runId: 'r' });
    // 同一份快照引用：不会再 prune，所以残留的 selection 还在。
    workspaceStore.set((s) => ({ ...s, error: 'x' }));
    expect(Object.keys(store.get().selections)).toEqual(['s-gone']);
    workspaceStore.set((s) => ({ ...s, snapshot: { ...snapshot } }));
    expect(store.get().selections).toEqual({});
    stop();
    resetWorkspace();
  });

  it('ackScope：scope 内没有可见 notice 时不写 store；有则确认', () => {
    const snapshot = terminalSnapshot('running');
    workspaceStore.set((s) => ({ ...s, snapshot, selectedId: WS }));
    const T = resource('term-1');
    const before = store.get();
    ackScope(T);
    expect(store.get()).toBe(before);
    // 终端已关闭 → confirmation；交互后确认。
    const closed = terminalSnapshot('closed');
    workspaceStore.set((s) => ({ ...s, snapshot: closed }));
    ackScope(T);
    expect(store.get().acks).toEqual({ 'terminal:term-1:state': 'inst-1:pty-1' });
    const settled = store.get();
    ackScope(T);
    expect(store.get()).toBe(settled);
    resetWorkspace();
  });
});
