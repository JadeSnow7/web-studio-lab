import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkbenchSnapshotSchema,
  type PageCapture,
  type PaneLayout,
  type WorkbenchCommand,
  type WorkbenchResult,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { cancelContextCapture, captureContext, captureStore, toggleCapture } from './capture';
import { receiverActions, receiverStore } from './capture-receiver';
import { projectSnapshot, switchWorkspace, workspaceCommand, workspaceStore } from './workspace';
import { statusPresentationStore } from './status-view';
import { shellStore } from './shell';

/*
 * OPS-1 S1（B3）：「选择元素」一步发起采集。接收者与页面身份在发起时冻结（requestId）；重复触发只有一个请求、
 * 至多一个自动新建会话；取消后清理本次自动新建且未使用的会话标签（R8）；完成且未导航时有条件展开并把焦点交给接收会话（R9），
 * 否则只在网页状态槽提示。下面用一个最小的“假 Main”按命令改写快照。
 */

const page = { webContentsId: 7, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: 'TaskFlow', partition: 'test' };
const capture: PageCapture = {
  captureId: 'captured',
  capturedAt: '2026-10-23T00:00:00Z',
  page,
  element: {
    tagName: 'p',
    id: null,
    classes: [],
    role: null,
    ariaLabel: null,
    testId: null,
    text: 'element',
    selector: 'p',
    rect: { x: 0, y: 0, width: 1, height: 1 },
  },
  screenshot: { viewport: 'data:image/png;base64,AA', element: null },
  consoleIssues: [],
};

function workspace(workspaceId: string, sessions: string[], layout: PaneLayout, open = sessions) {
  return {
    workspaceId,
    name: workspaceId,
    revision: 1,
    theme: 'light',
    runs: [],
    layout,
    activePaneId: layout.kind === 'pane' ? layout.paneId : 'p-web',
    tabs: [
      {
        tabId: `${workspaceId}-t-web`,
        title: 'web',
        pinned: false,
        group: null,
        targetRef: { kind: 'web', resourceId: `${workspaceId}-web` },
      },
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
        resourceId: `${workspaceId}-web`,
        kind: 'web',
        environmentId: 'local',
        title: 'web',
        url: page.url,
        instanceId: 'native',
        generation: 1,
        terminal: null,
        unavailableReason: null,
        preview: {
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
        },
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
    })),
  };
}
const single = (workspaceId = 'W'): PaneLayout => ({ kind: 'pane', paneId: 'p-web', tabId: `${workspaceId}-t-web` });
const beside = (sessionId: string): PaneLayout => ({
  kind: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  first: { kind: 'pane', paneId: 'p-web', tabId: 'W-t-web' },
  second: { kind: 'pane', paneId: `p-${sessionId}`, tabId: `t-${sessionId}` },
});

let main: WorkbenchSnapshot;
let calls: WorkbenchCommand[];
let focused: string[];
let focusWorkbench: ReturnType<typeof vi.fn>;
let hold: Partial<Record<WorkbenchCommand['type'], Promise<void>>>;

const space = (id = 'W') => main.workspaces.find((w) => w.workspaceId === id)!;
const sessionOf = (id: string) => main.workspaces.flatMap((w) => w.sessions).find((s) => s.sessionId === id);
const leaves = (layout: PaneLayout): Array<Extract<PaneLayout, { kind: 'pane' }>> =>
  layout.kind === 'pane' ? [layout] : [...leaves(layout.first), ...leaves(layout.second)];
const replace = (layout: PaneLayout, paneId: string, next: (p: Extract<PaneLayout, { kind: 'pane' }>) => PaneLayout): PaneLayout =>
  layout.kind === 'pane'
    ? layout.paneId === paneId
      ? next(layout)
      : layout
    : { ...layout, first: replace(layout.first, paneId, next), second: replace(layout.second, paneId, next) };

function publish() {
  main = structuredClone(main);
  main.seq++;
  projectSnapshot(structuredClone(main));
}
/** 一个按命令改写快照的假 Main；元数据命令核对 expectedRevision，与真实 Main 一样冲突时拒绝。 */
async function fakeMain(command: WorkbenchCommand): Promise<WorkbenchResult> {
  calls.push(command);
  await hold[command.type];
  const w = space(command.workspaceId);
  if (command.expectedRevision !== undefined && command.expectedRevision !== w.revision)
    return { ok: false, error: { code: 'conflict', message: '空间已有较新修改，请重新加载' }, snapshot: structuredClone(main) };
  const tabOf = (resourceId: string) => w.tabs.find((t) => t.targetRef.resourceId === resourceId);
  const show = (tabId: string) => {
    const at = leaves(w.layout).find((p) => p.tabId === tabId);
    if (at) w.activePaneId = at.paneId;
    else w.layout = replace(w.layout, w.activePaneId, (p) => ({ ...p, tabId }));
  };
  switch (command.type) {
    case 'createTab': {
      const id = `auto-${w.sessions.length + 1}`;
      w.resources.push({
        ...structuredClone(w.resources.find((r) => r.kind === 'session') ?? w.resources[0]!),
        resourceId: `r-${id}`,
        kind: 'session',
        title: command.title,
        preview: null,
      });
      w.sessions.push({ ...workspace('X', [id], single()).sessions[0]!, title: command.title } as never);
      w.tabs.push({
        tabId: `t-${id}`,
        title: command.title,
        pinned: false,
        group: null,
        targetRef: { kind: 'session', resourceId: `r-${id}` },
        autoTitle: false,
      });
      if (command.activate !== false) show(`t-${id}`);
      break;
    }
    case 'openTab':
      show(tabOf(command.resourceId)!.tabId);
      break;
    case 'activateTab':
      show(command.tabId);
      break;
    case 'focusPane':
      w.activePaneId = command.paneId;
      break;
    case 'closeTab':
      w.tabs = w.tabs.filter((t) => t.tabId !== command.tabId);
      for (const p of leaves(w.layout))
        if (p.tabId === command.tabId) w.layout = replace(w.layout, p.paneId, (x) => ({ ...x, tabId: null }));
      break;
    case 'splitPane':
      w.layout = replace(w.layout, command.paneId, (p) => ({
        kind: 'split',
        direction: command.direction,
        ratio: 0.5,
        first: p,
        second: { kind: 'pane', paneId: 'p-new', tabId: command.tabId ?? null },
      }));
      w.activePaneId = 'p-new';
      break;
    case 'switchWorkspace':
      main.activeWorkspaceId = command.workspaceId;
      break;
    case 'saveDraft':
      w.sessions.find((s) => s.sessionId === command.sessionId)!.draft = command.draft;
      break;
    case 'captureContext':
      w.resources.find((r) => r.resourceId === command.resourceId)!.preview!.picking = true;
      w.sessions.find((s) => s.sessionId === command.sessionId)!.captureRequest = {
        requestId: command.requestId,
        resourceId: command.resourceId,
        state: 'pending',
        error: null,
      };
      break;
    case 'cancelCapture':
      w.resources.find((r) => r.resourceId === command.resourceId)!.preview!.picking = false;
      for (const s of w.sessions) if (s.captureRequest?.requestId === command.requestId) s.captureRequest.state = 'cancelled';
      break;
    case 'browserAction':
      if (command.action === 'cancelPick') w.resources.find((r) => r.resourceId === command.resourceId)!.preview!.picking = false;
      break;
  }
  if (!['captureContext', 'cancelCapture', 'browserAction', 'switchWorkspace'].includes(command.type)) w.revision++;
  main.seq++;
  return { ok: true, snapshot: structuredClone(main) };
}
/** Main 收到页面里的点击并写入采集结果（或页面里按 Esc 取消）。 */
function finish(sessionId: string, state: 'completed' | 'cancelled' = 'completed') {
  const s = sessionOf(sessionId)!;
  const w = main.workspaces.find((x) => x.sessions.includes(s))!;
  w.resources.find((r) => r.resourceId === s.captureRequest!.resourceId)!.preview!.picking = false;
  s.captureRequest = { ...s.captureRequest!, state };
  if (state === 'completed') {
    s.context = capture;
    s.contextTarget = { kind: 'web', resourceId: s.captureRequest.resourceId };
    s.taskTargetRef = { kind: 'web', resourceId: s.captureRequest.resourceId };
  }
  publish();
}
const types = () => calls.map((c) => c.type);
const layoutCalls = () => calls.filter((c) => ['splitPane', 'focusPane', 'activateTab', 'closePane'].includes(c.type));
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const hints = () => statusPresentationStore.get().hints;

function setup(workspaces: Array<ReturnType<typeof workspace>>) {
  main = WorkbenchSnapshotSchema.parse({ appInstanceId: 'flow', storageError: null, activeWorkspaceId: 'W', seq: 1, workspaces });
  calls = [];
  focused = [];
  hold = {};
  focusWorkbench = vi.fn(async () => true);
  workspaceStore.set(() => ({ snapshot: structuredClone(main), selectedId: 'W', error: null }));
  receiverStore.set(() => ({ explicit: {}, activity: {} }));
  statusPresentationStore.set((s) => ({ ...s, hints: [] }));
  shellStore.set((s) => ({ ...s, route: 'space', focusMode: false }));
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    queueMicrotask(() => fn(0));
    return 1;
  });
  vi.stubGlobal('document', {
    getElementById: (id: string) => ({ isConnected: true, closest: () => null, focus: () => focused.push(id) }),
  });
  vi.stubGlobal('window', {
    innerWidth: 1440,
    studio: { workbench: { command: vi.fn(fakeMain) }, shell: { focusWorkbench } },
  });
}
afterEach(async () => {
  // 请求身份是模块级展示状态：每个用例结束时取消仍在进行的采集，避免泄漏到下一个用例。
  for (const [workspaceId, resourceId] of [
    ['W', 'W-web'],
    ['V', 'V-web'],
  ] as const)
    await Promise.resolve()
      .then(() => cancelContextCapture(workspaceId, resourceId))
      .catch(() => null);
  await settle();
  vi.unstubAllGlobals();
});

describe('一步点选与接收者冻结（O02、O03、O03d）', () => {
  beforeEach(() => setup([workspace('W', [], single())]));

  it('空间没有会话：发起时自动新建「{网页标题} · 会话」（不占用窗格），并以它为本次接收者', async () => {
    await toggleCapture('W', 'W-web');
    expect(types()).toEqual(['createTab', 'openTab', 'captureContext']);
    expect(calls[0]).toMatchObject({ type: 'createTab', kind: 'session', title: 'web · 会话', activate: false });
    const request = calls[2] as Extract<WorkbenchCommand, { type: 'captureContext' }>;
    expect(request.sessionId).toBe('auto-1');
    // 自动新建不改布局：网页仍是唯一窗格的内容。
    expect(leaves(space().layout).map((p) => p.tabId)).toEqual(['W-t-web']);
  });

  it('连点 / 同时触发：只有一个请求、至多一个自动新建会话', async () => {
    await Promise.all([toggleCapture('W', 'W-web'), toggleCapture('W', 'W-web'), toggleCapture('W', 'W-web')]);
    expect(types().filter((t) => t === 'createTab')).toHaveLength(1);
    expect(types().filter((t) => t === 'captureContext')).toHaveLength(1);
    expect(space().sessions).toHaveLength(1);
    expect(captureStore.get().starting).toEqual({});
  });

  it('Main 尚未开始点选时重复触发不替换请求；就绪后取消同一请求并清理自动会话', async () => {
    const gate: { release?: () => void } = {};
    hold.captureContext = new Promise<void>((resolve) => (gate.release = resolve));
    const opening = toggleCapture('W', 'W-web');
    await settle();
    expect(types()).toEqual(['createTab', 'openTab', 'captureContext']);
    const request = calls.at(-1);
    if (request?.type !== 'captureContext' || !gate.release) throw new Error('采集启动未到达故障门');
    expect(captureStore.get().starting).not.toEqual({});
    expect(space().resources[0]?.preview?.picking).toBe(false);
    await Promise.all([toggleCapture('W', 'W-web'), toggleCapture('W', 'W-web')]);
    expect(types()).toEqual(['createTab', 'openTab', 'captureContext']);
    gate.release();
    await opening;
    expect(captureStore.get().starting).toEqual({});
    expect(sessionOf(request.sessionId)?.captureRequest).toMatchObject({ requestId: request.requestId, state: 'pending' });
    await toggleCapture('W', 'W-web');
    expect(calls.find((c) => c.type === 'cancelCapture')).toMatchObject({ requestId: request.requestId });
    expect(sessionOf(request.sessionId)?.captureRequest).toMatchObject({ requestId: request.requestId, state: 'cancelled' });
    expect(sessionOf(request.sessionId)?.context).toBeNull();
    expect(space().tabs.some((t) => t.targetRef.resourceId === sessionOf(request.sessionId)?.resourceId)).toBe(false);
  });

  it('采集途中改接收者：已发起的请求仍归原会话，改动只影响下一次采集', async () => {
    setup([workspace('W', ['A', 'B'], beside('A'))]);
    await toggleCapture('W', 'W-web');
    expect(calls.at(-1)).toMatchObject({ type: 'captureContext', sessionId: 'A' });
    receiverActions.choose('W', 'W-web', 'B');
    finish('A');
    await settle();
    // 证据归原接收者，展开与焦点也只作用于原接收者。
    expect(sessionOf('A')?.context).toEqual(capture);
    expect(sessionOf('B')?.context).toBeNull();
    expect(focused).toEqual(['draft-A']);
    // 下一次采集使用新的显式选择。
    await toggleCapture('W', 'W-web');
    expect(calls.at(-1)).toMatchObject({ type: 'captureContext', sessionId: 'B' });
  });

  it('再次触发即取消：只取消本工作台发起的那个请求；Main 在选择而本工作台没有请求时取消页面里的选择', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    await toggleCapture('W', 'W-web');
    const request = calls.at(-1) as Extract<WorkbenchCommand, { type: 'captureContext' }>;
    await toggleCapture('W', 'W-web');
    expect(calls.at(-1)).toMatchObject({ type: 'cancelCapture', resourceId: 'W-web', requestId: request.requestId });
    space().resources[0]!.preview!.picking = true;
    publish();
    await toggleCapture('W', 'W-web');
    expect(calls.at(-1)).toMatchObject({ type: 'browserAction', resourceId: 'W-web', action: 'cancelPick' });
  });
});

describe('R8：自动新建且未使用的会话在取消后关闭标签（O04）', () => {
  it('再点按钮取消：关闭本次自动新建的会话标签（会话本身无法用现有命令移除）', async () => {
    setup([workspace('W', [], single())]);
    await toggleCapture('W', 'W-web');
    await toggleCapture('W', 'W-web');
    await settle();
    expect(calls.at(-1)).toMatchObject({ type: 'closeTab', tabId: 't-auto-1' });
    expect(space().tabs.map((t) => t.tabId)).not.toContain('t-auto-1');
  });

  it('页面里按 Esc（Main 记为已取消）：同样关闭；已有草稿的自动会话不关闭', async () => {
    setup([workspace('W', [], single())]);
    await toggleCapture('W', 'W-web');
    finish('auto-1', 'cancelled');
    await settle();
    expect(calls.at(-1)).toMatchObject({ type: 'closeTab', tabId: 't-auto-1' });

    await toggleCapture('W', 'W-web');
    await workspaceCommand('W', { type: 'saveDraft', sessionId: 'auto-2', draft: '先记下' });
    finish('auto-2', 'cancelled');
    await settle();
    expect(types().filter((t) => t === 'closeTab')).toHaveLength(1);
  });

  it('接收者是已有会话：取消后不关闭它的标签', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    await toggleCapture('W', 'W-web');
    await toggleCapture('W', 'W-web');
    await settle();
    expect(types()).not.toContain('closeTab');
  });

  it('完成的自动会话不再是“未使用”：之后的取消不会关闭它', async () => {
    setup([workspace('W', [], single())]);
    await toggleCapture('W', 'W-web');
    finish('auto-1');
    await settle();
    expect(types()).not.toContain('closeTab');
  });
});

describe('条件展开与焦点（O04a、O04b、R9）', () => {
  it('接收会话已在旁边窗格：原位更新，聚焦该窗格，Main 先聚焦工作台再由 renderer 聚焦输入框', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    await toggleCapture('W', 'W-web');
    finish('A');
    await settle();
    expect(layoutCalls()).toMatchObject([{ type: 'focusPane', paneId: 'p-A' }]);
    expect(focusWorkbench).toHaveBeenCalledTimes(1);
    expect(focused).toEqual(['draft-A']);
    expect(types()).not.toContain('locateSession');
    expect(hints()).toEqual([]);
  });

  it('接收会话不可见、未满四窗格：在源网页旁分屏放入会话（不替换已占用窗格）', async () => {
    setup([workspace('W', ['A'], single())]);
    receiverActions.choose('W', 'W-web', 'A');
    await toggleCapture('W', 'W-web');
    finish('A');
    await settle();
    expect(layoutCalls()).toMatchObject([{ type: 'splitPane', paneId: 'p-web', direction: 'horizontal', tabId: 't-A' }]);
    expect(leaves(space().layout).map((p) => p.tabId)).toEqual(['W-t-web', 't-A']);
    expect(focused).toEqual(['draft-A']);
  });

  it('有空窗格：放入空窗格', async () => {
    const layout: PaneLayout = {
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { kind: 'pane', paneId: 'p-web', tabId: 'W-t-web' },
      second: { kind: 'pane', paneId: 'p-empty', tabId: null },
    };
    setup([workspace('W', ['A'], layout)]);
    receiverActions.choose('W', 'W-web', 'A');
    await toggleCapture('W', 'W-web');
    finish('A');
    await settle();
    expect(layoutCalls()).toMatchObject([
      { type: 'focusPane', paneId: 'p-empty' },
      { type: 'activateTab', tabId: 't-A' },
    ]);
    expect(leaves(space().layout).map((p) => p.tabId)).toEqual(['W-t-web', 't-A']);
    expect(focused).toEqual(['draft-A']);
  });

  it('窄窗：只保存证据并在网页状态槽提示「已采集到 {会话} · 打开」，不改布局、不抢焦点', async () => {
    setup([workspace('W', ['A'], single())]);
    vi.stubGlobal('window', { innerWidth: 900, studio: { workbench: { command: vi.fn(fakeMain) }, shell: { focusWorkbench } } });
    receiverActions.choose('W', 'W-web', 'A');
    await toggleCapture('W', 'W-web');
    finish('A');
    await settle();
    expect(layoutCalls()).toEqual([]);
    expect(focusWorkbench).not.toHaveBeenCalled();
    expect(focused).toEqual([]);
    expect(hints()).toMatchObject([
      {
        key: 'ui:W-web:captured',
        scope: { kind: 'resource', workspaceId: 'W', resourceId: 'W-web' },
        label: '已采集到 A',
        action: { id: 'session.open', label: '打开' },
        locate: { workspaceId: 'W', sessionId: 'A' },
      },
    ]);
  });

  it('用户已导航：只提示，焦点不被移动', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    await toggleCapture('W', 'W-web');
    await workspaceCommand('W', { type: 'focusPane', paneId: 'p-web' });
    calls = [];
    finish('A');
    await settle();
    expect(layoutCalls()).toEqual([]);
    expect(focused).toEqual([]);
    expect(hints()).toHaveLength(1);
  });

  it('Main 不能聚焦工作台窗口（窗口不在前台）时 renderer 也不移动焦点', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    focusWorkbench.mockResolvedValue(false);
    await toggleCapture('W', 'W-web');
    finish('A');
    await settle();
    expect(focusWorkbench).toHaveBeenCalledTimes(1);
    expect(focused).toEqual([]);
  });
});

describe('迟到结果不污染新目标（O03a、O03c）', () => {
  it('采集途中切空间：证据归原空间与会话，不改任何空间布局，不抢焦点，提示留在原网页', async () => {
    setup([workspace('W', ['A'], beside('A')), workspace('V', ['Z'], single('V'))]);
    await toggleCapture('W', 'W-web');
    await switchWorkspace('V');
    calls = [];
    finish('A');
    await settle();
    expect(sessionOf('A')?.context).toEqual(capture);
    expect(sessionOf('Z')?.context).toBeNull();
    expect(layoutCalls()).toEqual([]);
    expect(focused).toEqual([]);
    expect(hints()).toMatchObject([{ scope: { kind: 'resource', workspaceId: 'W', resourceId: 'W-web' } }]);
  });

  it('取消后迟到的完成回执：不提示、不改布局、不抢焦点', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    await toggleCapture('W', 'W-web');
    await cancelContextCapture('W', 'W-web');
    calls = [];
    const s = sessionOf('A')!;
    s.captureRequest = { ...s.captureRequest!, state: 'completed' };
    s.context = capture;
    publish();
    await settle();
    expect(calls).toEqual([]);
    expect(focused).toEqual([]);
    expect(hints()).toEqual([]);
  });

  it('展开命令遇到版本冲突（布局已被他处改变）：不再改布局，改为提示', async () => {
    setup([workspace('W', ['A'], single())]);
    receiverActions.choose('W', 'W-web', 'A');
    await toggleCapture('W', 'W-web');
    let release!: () => void;
    hold.splitPane = new Promise<void>((resolve) => (release = resolve));
    finish('A');
    await settle();
    // 另一处（如其他窗口）先改了布局：带冻结版本的分屏被拒绝。
    space().revision++;
    release();
    await settle();
    expect(focused).toEqual([]);
    expect(hints()).toHaveLength(1);
  });
});

describe('既有入口：会话里的「重新选择元素」以该会话为显式接收者', () => {
  it('captureContext 仍按给定会话冻结接收者，完成后同样展开而不跳到「上下文」', async () => {
    setup([workspace('W', ['A'], beside('A'))]);
    await captureContext('W', 'A', 'W-web');
    finish('A');
    await settle();
    expect(types()).not.toContain('locateSession');
    expect(focused).toEqual(['draft-A']);
  });
});
