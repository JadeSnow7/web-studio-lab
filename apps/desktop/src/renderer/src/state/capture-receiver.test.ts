import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceSnapshotSchema, type PageCapture, type PaneLayout, type WorkspaceSnapshot } from '@wsl/protocol';
import {
  ACTIVITY_LIMIT,
  autoSessionCleanup,
  autoSessionTitle,
  decideExpansion,
  receiverActions,
  receiverStore,
  referenceLabel,
  resolveDefaultReceiver,
  restoreActivity,
  taskReference,
  taskSettingsSummary,
} from './capture-receiver';

/*
 * OPS-1 S1（B3）：默认接收者、采集完成后的条件展开、R8 自动会话清理与单一任务目标的纯规则。
 * 输入都是 Main 快照的投影与本设备的展示偏好；这些函数不调用 IPC。
 */

const page = { webContentsId: 7, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: 'TaskFlow', partition: 'test' };
const capture = (patch: Partial<PageCapture['element']> = {}): PageCapture => ({
  captureId: 'cap-1',
  capturedAt: '2026-10-23T00:00:00Z',
  page,
  element: {
    tagName: 'button',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: '保存',
    selector: 'button',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    ...patch,
  },
  screenshot: { viewport: 'data:image/png;base64,AA', element: null },
  consoleIssues: [],
});

const pane = (paneId: string, tabId: string | null): PaneLayout => ({ kind: 'pane', paneId, tabId });
const split = (first: PaneLayout, second: PaneLayout, direction: 'horizontal' | 'vertical' = 'horizontal'): PaneLayout => ({
  kind: 'split',
  direction,
  ratio: 0.5,
  first,
  second,
});

/**
 * 空间：一个网页（tab t-web）、一个终端（tab t-term）与给定会话；open 中的会话有标签（t-{id}），其余标签已关闭。
 */
function space({
  sessions = [],
  open = sessions,
  layout = pane('p-web', 't-web'),
  patch = {},
}: {
  sessions?: string[];
  open?: string[];
  layout?: PaneLayout;
  patch?: Partial<Record<string, Partial<WorkspaceSnapshot['sessions'][number]>>>;
} = {}): WorkspaceSnapshot {
  const firstPane = (layout: PaneLayout): string => (layout.kind === 'pane' ? layout.paneId : firstPane(layout.first));
  return WorkspaceSnapshotSchema.parse({
    workspaceId: 'W',
    name: '空间',
    revision: 3,
    theme: 'light',
    layout,
    activePaneId: firstPane(layout),
    runs: [],
    tabs: [
      { tabId: 't-web', title: 'TaskFlow 预览', pinned: false, group: null, targetRef: { kind: 'web', resourceId: 'web' } },
      { tabId: 't-term', title: '开发终端', pinned: false, group: null, targetRef: { kind: 'terminal', resourceId: 'term' } },
      ...open.map((id) => ({
        tabId: `t-${id}`,
        title: id,
        pinned: false,
        group: null,
        targetRef: { kind: 'session', resourceId: `r-${id}` },
      })),
    ],
    resources: [
      {
        resourceId: 'web',
        kind: 'web',
        environmentId: 'local',
        title: 'TaskFlow 预览',
        url: page.url,
        instanceId: 'native',
        generation: 1,
        preview: null,
        terminal: null,
        unavailableReason: null,
      },
      {
        resourceId: 'term',
        kind: 'terminal',
        environmentId: 'sandbox',
        title: '开发终端',
        url: null,
        instanceId: null,
        generation: 0,
        preview: null,
        terminal: null,
        unavailableReason: null,
      },
      ...sessions.map((id) => ({
        resourceId: `r-${id}`,
        kind: 'session',
        environmentId: null,
        title: id,
        url: null,
        instanceId: null,
        generation: 0,
        preview: null,
        terminal: null,
        unavailableReason: null,
      })),
    ],
    sessions: sessions.map((id) => ({
      sessionId: id,
      resourceId: `r-${id}`,
      title: id,
      draft: '',
      conversation: null,
      context: null,
      contextTarget: null,
      taskTargetRef: null,
      contextApplicability: 'unknown',
      taskVersions: [],
      ...patch[id],
    })),
  });
}

const resolve = (workspace: WorkspaceSnapshot, explicit: string | null = null, activity: Record<string, number> = {}) =>
  resolveDefaultReceiver({ workspace, resourceId: 'web', explicitSessionId: explicit, activity });

describe('默认接收者（O02a）：显式有效选择 > 同屏最近活动 > 本空间最近活动 > 自动新建', () => {
  it('显式选择且仍有效时优先，即使同屏有更近活动的会话', () => {
    const w = space({ sessions: ['A', 'B'], layout: split(pane('p-web', 't-web'), pane('p-b', 't-B')) });
    expect(resolve(w, 'A', { B: 9 })).toEqual({ rule: 'explicit', sessionId: 'A', title: 'A' });
  });
  it('显式选择的会话标签已关闭或会话已不在快照中：回落到下一条规则', () => {
    const closed = space({ sessions: ['A', 'B'], open: ['B'], layout: split(pane('p-web', 't-web'), pane('p-b', 't-B')) });
    expect(resolve(closed, 'A')).toEqual({ rule: 'same-screen', sessionId: 'B', title: 'B' });
    const missing = space({ sessions: ['B'], layout: split(pane('p-web', 't-web'), pane('p-b', 't-B')) });
    expect(resolve(missing, 'gone')).toEqual({ rule: 'same-screen', sessionId: 'B', title: 'B' });
  });
  it('同屏候选优先于本空间更近活动的会话', () => {
    const w = space({ sessions: ['A', 'B'], layout: split(pane('p-web', 't-web'), pane('p-a', 't-A')) });
    expect(resolve(w, null, { A: 1, B: 50 })).toEqual({ rule: 'same-screen', sessionId: 'A', title: 'A' });
  });
  it('多个同屏候选：取最近活动的；都没有活动记录时按窗格顺序取第一个', () => {
    const layout = split(split(pane('p-web', 't-web'), pane('p-b', 't-B'), 'vertical'), pane('p-a', 't-A'));
    const w = space({ sessions: ['A', 'B'], layout });
    expect(resolve(w)).toEqual({ rule: 'same-screen', sessionId: 'B', title: 'B' });
    expect(resolve(w, null, { A: 2 })).toEqual({ rule: 'same-screen', sessionId: 'A', title: 'A' });
    expect(resolve(w, null, { A: 2, B: 3 })).toEqual({ rule: 'same-screen', sessionId: 'B', title: 'B' });
  });
  it('没有同屏会话：取本空间最近活动且标签仍打开的会话', () => {
    const w = space({ sessions: ['A', 'B', 'C'], open: ['A', 'B'] });
    expect(resolve(w, null, { A: 1, B: 4, C: 99 })).toEqual({ rule: 'space', sessionId: 'B', title: 'B' });
  });
  it('活动记录只是展示偏好：每次使用前对照快照，已不存在的会话不参与', () => {
    const w = space({ sessions: ['A'] });
    expect(resolve(w, null, { ghost: 100, A: 1 })).toEqual({ rule: 'space', sessionId: 'A', title: 'A' });
  });
  it('都没有：发起时自动新建「{网页标题} · 会话」（本空间会话都没有活动记录时也是）', () => {
    expect(resolve(space())).toEqual({ rule: 'auto', sessionId: null, title: 'TaskFlow 预览 · 会话' });
    expect(resolve(space({ sessions: ['A'] }))).toEqual({ rule: 'auto', sessionId: null, title: 'TaskFlow 预览 · 会话' });
    expect(autoSessionTitle({ title: '成员页' })).toBe('成员页 · 会话');
  });
});

describe('采集完成后的条件展开（O04a）', () => {
  const base = { sessionId: 'A', resourceId: 'web', navigated: false, narrow: false };
  it('接收会话已在某窗格可见：原位更新该窗格', () => {
    const w = space({ sessions: ['A'], layout: split(pane('p-web', 't-web'), pane('p-a', 't-A')) });
    expect(decideExpansion({ ...base, workspace: w })).toEqual({ kind: 'in-place', paneId: 'p-a' });
  });
  it('否则优先放入空窗格，不替换已占用窗格', () => {
    const w = space({ sessions: ['A'], layout: split(pane('p-web', 't-web'), split(pane('p-term', 't-term'), pane('p-empty', null))) });
    expect(decideExpansion({ ...base, workspace: w })).toEqual({ kind: 'empty-pane', paneId: 'p-empty', tabId: 't-A' });
  });
  it('没有空窗格且未满四窗格：在源网页窗格旁分屏', () => {
    const w = space({ sessions: ['A'], layout: split(pane('p-term', 't-term'), pane('p-web', 't-web')) });
    expect(decideExpansion({ ...base, workspace: w })).toEqual({ kind: 'split', paneId: 'p-web', tabId: 't-A' });
  });
  it('四窗格已满：只提示', () => {
    const layout = split(split(pane('p-web', 't-web'), pane('p-term', 't-term')), split(pane('p-x', 't-X'), pane('p-y', 't-Y')));
    const w = space({ sessions: ['A', 'X', 'Y'], layout });
    expect(decideExpansion({ ...base, workspace: w })).toEqual({ kind: 'hint', reason: 'full' });
  });
  it('窄窗（或只投影活动窗格）、已导航、空间不在：只提示', () => {
    const w = space({ sessions: ['A'] });
    expect(decideExpansion({ ...base, workspace: w, narrow: true })).toEqual({ kind: 'hint', reason: 'narrow' });
    expect(decideExpansion({ ...base, workspace: w, navigated: true })).toEqual({ kind: 'hint', reason: 'navigated' });
    expect(decideExpansion({ ...base, workspace: undefined })).toEqual({ kind: 'hint', reason: 'navigated' });
  });
  it('接收会话标签已关闭：只保存证据并提示，不重开、不新建（O03b）', () => {
    const w = space({ sessions: ['A'], open: [] });
    expect(decideExpansion({ ...base, workspace: w })).toEqual({ kind: 'hint', reason: 'receiver-closed' });
  });
  it('源网页已不在任何窗格：没有可并排的位置，只提示', () => {
    const w = space({ sessions: ['A'], layout: pane('p-term', 't-term') });
    expect(decideExpansion({ ...base, workspace: w })).toEqual({ kind: 'hint', reason: 'source-hidden' });
  });
});

describe('R8：本次自动新建且未使用的会话在采集取消后关闭标签', () => {
  it('没有消息、草稿、任务版本与采集证据：关闭其标签', () => {
    expect(autoSessionCleanup(space({ sessions: ['A'] }), 'A')).toEqual({ tabId: 't-A' });
  });
  const conversation = {
    conversationId: 'session-A',
    generation: 'g',
    seq: 1,
    threadId: null,
    turnId: null,
    state: 'idle',
    messages: [{ id: 'm', role: 'user', text: 'hi' }],
    toolExecutions: [],
    warnings: [],
    cleanupPending: false,
    error: null,
  };
  const used: Array<[string, Partial<WorkspaceSnapshot['sessions'][number]>]> = [
    ['已有消息', { conversation: { ...conversation, state: 'idle', messages: [{ id: 'm', role: 'user', text: 'hi' }] } }],
    ['已有草稿', { draft: '还没发送' }],
    ['已有采集证据', { context: capture() }],
  ];
  it.each(used)('%s：不关闭', (_name, patch) => {
    const w = space({ sessions: ['A'], patch: { A: patch } });
    expect(autoSessionCleanup(w, 'A')).toBeNull();
  });
  it('已有任务版本或运行：不关闭', () => {
    const w = space({ sessions: ['A'] });
    w.runs.push({ runId: 'run', sessionId: 'A' } as never);
    expect(autoSessionCleanup(w, 'A')).toBeNull();
  });
  it('标签已关闭或会话不存在：没有可关的标签', () => {
    expect(autoSessionCleanup(space({ sessions: ['A'], open: [] }), 'A')).toBeNull();
    expect(autoSessionCleanup(space(), 'A')).toBeNull();
    expect(autoSessionCleanup(undefined, 'A')).toBeNull();
  });
});

describe('单一任务目标（§9.1）：引用标签与任务设置中的目标', () => {
  it('网页目标且有该页的采集：引用标签为「元素文字或标签名 · 页面标题」', () => {
    const w = space({
      sessions: ['A'],
      patch: {
        A: { taskTargetRef: { kind: 'web', resourceId: 'web' }, context: capture(), contextTarget: { kind: 'web', resourceId: 'web' } },
      },
    });
    expect(taskReference(w, w.sessions[0]!)).toMatchObject({ kind: 'page', resourceId: 'web', label: '保存 · TaskFlow' });
    expect(referenceLabel(capture({ text: '   ' }))).toBe('button · TaskFlow');
    expect(referenceLabel(capture({ text: 'x'.repeat(80) }))).toBe(`${'x'.repeat(40)}… · TaskFlow`);
  });
  it('网页目标但没有该页的采集：仍显示为引用标签并说明未选择元素', () => {
    const w = space({ sessions: ['A'], patch: { A: { taskTargetRef: { kind: 'web', resourceId: 'web' } } } });
    expect(taskReference(w, w.sessions[0]!)).toEqual({
      kind: 'page',
      resourceId: 'web',
      capture: null,
      label: 'TaskFlow 预览 · 未选择元素',
    });
  });
  it('文件 / 终端 / SSH 目标属于任务设置，不显示页面引用', () => {
    const w = space({ sessions: ['A'], patch: { A: { taskTargetRef: { kind: 'terminal', resourceId: 'term' } } } });
    expect(taskReference(w, w.sessions[0]!)).toEqual({ kind: 'resource', resourceId: 'term', title: '开发终端' });
    const none = space({ sessions: ['A'] });
    expect(taskReference(none, none.sessions[0]!)).toEqual({ kind: 'none' });
  });
  it('折叠摘要：范围与验收条数，另有设置中的目标时附上目标名', () => {
    expect(taskSettingsSummary({ scopes: 1, acceptance: 2, target: null })).toBe('范围 1 · 验收 2');
    expect(taskSettingsSummary({ scopes: 0, acceptance: 0, target: '开发终端' })).toBe('范围 0 · 验收 0 · 开发终端');
  });
});

describe('展示偏好：显式接收者与最近活动（§9.6）', () => {
  beforeEach(() => receiverStore.set(() => ({ explicit: {}, activity: {} })));
  it('显式选择按空间 + 网页记录，只影响之后的采集', () => {
    receiverActions.choose('W', 'web', 'A');
    expect(receiverActions.explicit('W', 'web')).toBe('A');
    expect(receiverActions.explicit('W', 'other-web')).toBeNull();
    expect(receiverActions.explicit('V', 'web')).toBeNull();
  });
  it('最近活动按空间记录、有上限，最早的先丢弃', () => {
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) receiverActions.record('W', `s-${i}`, 1000 + i * 2000);
    const recorded = receiverStore.get().activity['W']!;
    expect(Object.keys(recorded)).toHaveLength(ACTIVITY_LIMIT);
    expect(recorded['s-0']).toBeUndefined();
    expect(recorded[`s-${ACTIVITY_LIMIT + 4}`]).toBe(1000 + (ACTIVITY_LIMIT + 4) * 2000);
  });
  it('读取本机偏好：格式不对时整体丢弃或逐项过滤，不抛错', () => {
    expect(restoreActivity(null)).toEqual({});
    expect(restoreActivity('not json')).toEqual({});
    expect(restoreActivity(JSON.stringify([1, 2]))).toEqual({});
    expect(restoreActivity(JSON.stringify({ W: { A: 5, B: 'x', C: -1 }, V: 3 }))).toEqual({ W: { A: 5 } });
  });
});
