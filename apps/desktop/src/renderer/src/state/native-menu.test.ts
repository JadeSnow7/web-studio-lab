import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeMenuChoice, WorkbenchSnapshot, WorkspaceSnapshot } from '@wsl/protocol';
import {
  captureReceiverMenuEffect,
  menuAnchorFromClick,
  menuAnchorFromPointer,
  nativeMenuStore,
  newTabMenuEffect,
  openNativeMenu,
  paneMenuEffect,
  runRecordsMenuEffect,
  tabMenuEffect,
  webMoreMenuEffect,
} from './native-menu';
import { statusPresentationStore } from './status-view';
import { isCurrentNavigation, beginNavigation, projectSnapshot, workspaceCommand, workspaceStore } from './workspace';

/*
 * OPS-1 S5：菜单本身不执行业务。renderer 拿到 Main 返回的选择与冻结目标后：业务动作用冻结目标里的空间（不是当前活动空间），
 * 依赖布局 / 排序的动作带上菜单打开时的版本以触发版本冲突；只影响展示的动作在空间已切换时丢弃（O08b）。
 */

const workspace = (workspaceId: string, revision: number): WorkspaceSnapshot => ({
  workspaceId,
  name: workspaceId,
  revision,
  tabs: [
    {
      tabId: `${workspaceId}-t1`,
      title: '一',
      pinned: false,
      group: null,
      targetRef: { kind: 'web', resourceId: `${workspaceId}-web` },
      autoTitle: false,
    },
    {
      tabId: `${workspaceId}-t2`,
      title: '二',
      pinned: false,
      group: null,
      targetRef: { kind: 'session', resourceId: `${workspaceId}-r2` },
      autoTitle: false,
    },
    {
      tabId: `${workspaceId}-t3`,
      title: '三',
      pinned: false,
      group: null,
      targetRef: { kind: 'session', resourceId: `${workspaceId}-r3` },
      autoTitle: false,
    },
  ],
  resources: [],
  layout: { kind: 'pane', paneId: `${workspaceId}-p1`, tabId: `${workspaceId}-t1` },
  activePaneId: `${workspaceId}-p1`,
  sessions: [],
  runs: [],
  fileHints: [],
  observations: [],
  theme: 'light',
});
const view = (selectedId: string): { snapshot: WorkbenchSnapshot; selectedId: string } => ({
  selectedId,
  snapshot: {
    appInstanceId: 'app',
    storageError: null,
    activeWorkspaceId: selectedId,
    seq: 5,
    workspaces: [workspace('A', 8), workspace('B', 2)],
    environments: [],
    notificationReadReceipts: [],
    notifications: [],
  },
});
type Choice<M extends NativeMenuChoice['menuId']> = Extract<NativeMenuChoice, { menuId: M }>;
const tab = (itemId: Choice<'tab'>['itemId'], tabId = 'A-t2'): Choice<'tab'> => ({
  menuId: 'tab',
  itemId,
  target: { workspaceId: 'A', tabId, paneId: 'A-p1', revision: 7 },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('菜单位置（R3：键盘打开的菜单出现在焦点元素处）', () => {
  const element = { getBoundingClientRect: () => ({ x: 40, y: 60, width: 90, height: 28 }) };
  it('Enter / 空格触发的 click（detail = 0）使用触发元素的矩形', () => {
    expect(menuAnchorFromClick({ detail: 0, clientX: 0, clientY: 0 }, element)).toEqual({ x: 40, y: 60, width: 90, height: 28 });
  });
  it('鼠标点击使用指针位置', () => {
    expect(menuAnchorFromClick({ detail: 1, clientX: 70, clientY: 75 }, element)).toEqual({ x: 70, y: 75, width: 0, height: 0 });
  });
  it('右键使用指针位置', () => {
    expect(menuAnchorFromPointer({ clientX: 12, clientY: 34 })).toEqual({ x: 12, y: 34, width: 0, height: 0 });
  });
});

describe('迟到选择不作用于新空间（O08b）', () => {
  it('业务动作使用冻结目标的空间，而不是当前活动空间', () => {
    for (const selected of ['A', 'B']) {
      expect(tabMenuEffect(tab('close-tab'), view(selected))).toEqual({
        kind: 'command',
        workspaceId: 'A',
        payload: { type: 'closeTab', tabId: 'A-t2' },
      });
      expect(tabMenuEffect(tab('pin'), view(selected))).toMatchObject({ workspaceId: 'A', payload: { type: 'updateTab', pinned: true } });
      expect(tabMenuEffect(tab('unpin'), view(selected))).toMatchObject({
        workspaceId: 'A',
        payload: { type: 'updateTab', pinned: false },
      });
      expect(tabMenuEffect(tab('ungroup'), view(selected))).toMatchObject({
        workspaceId: 'A',
        payload: { type: 'updateTab', group: null },
      });
    }
  });

  it('排序与布局动作带菜单打开时的版本（7），而不是 renderer 当前看到的版本（8），布局已变时由 Main 以版本冲突拒绝', () => {
    expect(tabMenuEffect(tab('move-up'), view('B'))).toEqual({
      kind: 'command',
      workspaceId: 'A',
      payload: { type: 'reorderTabs', tabIds: ['A-t2', 'A-t1', 'A-t3'] },
      revision: 7,
    });
    expect(tabMenuEffect(tab('move-down'), view('A'))).toMatchObject({
      payload: { type: 'reorderTabs', tabIds: ['A-t1', 'A-t3', 'A-t2'] },
      revision: 7,
    });
    expect(tabMenuEffect(tab('open-right'), view('B'))).toEqual({
      kind: 'command',
      workspaceId: 'A',
      payload: { type: 'splitPane', paneId: 'A-p1', direction: 'horizontal', tabId: 'A-t2' },
      revision: 7,
    });
    expect(tabMenuEffect(tab('open-below'), view('A'))).toMatchObject({ payload: { direction: 'vertical' }, revision: 7 });
    const pane = (itemId: Choice<'pane'>['itemId']): Choice<'pane'> => ({
      menuId: 'pane',
      itemId,
      target: { workspaceId: 'A', paneId: 'A-p1', revision: 7 },
    });
    expect(paneMenuEffect(pane('split-right'))).toEqual({
      kind: 'command',
      workspaceId: 'A',
      payload: { type: 'splitPane', paneId: 'A-p1', direction: 'horizontal' },
      revision: 7,
    });
    expect(paneMenuEffect(pane('split-below'))).toMatchObject({ payload: { direction: 'vertical' }, revision: 7 });
    expect(paneMenuEffect(pane('equalize'))).toMatchObject({ payload: { type: 'setRatio', paneId: 'A-p1', ratio: 0.5 } });
    expect(paneMenuEffect(pane('close-pane'))).toMatchObject({
      workspaceId: 'A',
      payload: { type: 'closePane', paneId: 'A-p1' },
      revision: 7,
    });
  });

  it('越过两端的移动没有动作；标签已不在快照中也没有动作', () => {
    expect(tabMenuEffect(tab('move-up', 'A-t1'), view('A'))).toBeNull();
    expect(tabMenuEffect(tab('move-down', 'A-t3'), view('A'))).toBeNull();
    expect(tabMenuEffect(tab('move-up', 'gone'), view('A'))).toBeNull();
  });

  it('只影响展示的动作：同一空间时执行，空间已切换时丢弃', () => {
    expect(tabMenuEffect(tab('rename'), view('A'))).toEqual({ kind: 'rename', workspaceId: 'A', tabId: 'A-t2' });
    expect(tabMenuEffect(tab('set-group'), view('A'))).toEqual({ kind: 'group', workspaceId: 'A', tabId: 'A-t2' });
    expect(tabMenuEffect(tab('rename'), view('B'))).toBeNull();
    expect(tabMenuEffect(tab('set-group'), view('B'))).toBeNull();

    const runs: Choice<'run-records'> = { menuId: 'run-records', itemId: 'diff', target: { workspaceId: 'A', sessionId: 's' } };
    expect(runRecordsMenuEffect(runs, view('A'))).toEqual({ kind: 'view', view: 'diff' });
    expect(runRecordsMenuEffect(runs, view('B'))).toBeNull();

    const created: Choice<'new-tab'> = { menuId: 'new-tab', itemId: 'ssh', target: { workspaceId: 'A' } };
    expect(newTabMenuEffect(created, view('A'))).toEqual({ kind: 'create', workspaceId: 'A', tabKind: 'ssh' });
    expect(newTabMenuEffect(created, view('B'))).toBeNull();
  });

  it('网页 ⋯：收藏与正文快照按冻结空间执行；「管理 App」「查看空间资源」在空间切换后丢弃', () => {
    const more = (itemId: Choice<'web-more'>['itemId']): Choice<'web-more'> => ({
      menuId: 'web-more',
      itemId,
      target: { workspaceId: 'A', resourceId: 'A-web' },
    });
    expect(webMoreMenuEffect(more('bookmark'), view('B'))).toEqual({
      kind: 'catalog',
      action: 'bookmark',
      payload: { type: 'bookmarkRuntimeResource', workspaceId: 'A', runtimeResourceId: 'A-web' },
    });
    expect(webMoreMenuEffect(more('snapshot'), view('B'))).toEqual({
      kind: 'catalog',
      action: 'snapshot',
      payload: { type: 'captureResourceRevision', workspaceId: 'A', runtimeResourceId: 'A-web' },
    });
    expect(webMoreMenuEffect(more('manage-app'), view('A'))).toEqual({ kind: 'manage-app', workspaceId: 'A' });
    expect(webMoreMenuEffect(more('show-resources'), view('A'))).toEqual({ kind: 'show-resources', workspaceId: 'A' });
    expect(webMoreMenuEffect(more('manage-app'), view('B'))).toBeNull();
    expect(webMoreMenuEffect(more('show-resources'), view('B'))).toBeNull();
  });

  it('采集接收者（OPS-1 S1）：选择会话只设定之后采集的接收者，新建会话也不开始采集；空间已切换时都丢弃', () => {
    const receiver = (itemId: Choice<'capture-receiver'>['itemId'], sessionId: string | null): Choice<'capture-receiver'> => ({
      menuId: 'capture-receiver',
      itemId,
      target: { workspaceId: 'A', resourceId: 'A-web', sessionId },
    });
    expect(captureReceiverMenuEffect(receiver('session', 's-2'), view('A'))).toEqual({
      kind: 'choose',
      workspaceId: 'A',
      resourceId: 'A-web',
      sessionId: 's-2',
    });
    expect(captureReceiverMenuEffect(receiver('new-session', null), view('A'))).toEqual({
      kind: 'create',
      workspaceId: 'A',
      resourceId: 'A-web',
    });
    expect(captureReceiverMenuEffect(receiver('open-receiver', 's-2'), view('A'))).toEqual({
      kind: 'open',
      workspaceId: 'A',
      sessionId: 's-2',
    });
    for (const choice of [receiver('session', 's-2'), receiver('new-session', null), receiver('open-receiver', 's-2')])
      expect(captureReceiverMenuEffect(choice, view('B'))).toBeNull();
  });
});

describe('打开菜单失败', () => {
  it('Main 拒绝时登记一次界面错误并返回 null，不抛给调用方', async () => {
    const before = statusPresentationStore.get().uiErrors.length;
    vi.stubGlobal('window', {
      studio: {
        shell: {
          showMenu: vi
            .fn()
            .mockRejectedValue(new Error("Error invoking remote method 'shell:show-menu': Error: denied: 只能为活动空间打开菜单")),
        },
      },
    });
    await expect(openNativeMenu('new-tab', { workspaceId: 'A' })).resolves.toBeNull();
    const errors = statusPresentationStore.get().uiErrors;
    expect(errors.length).toBe(before + 1);
    expect(errors.at(-1)).toMatchObject({ message: 'denied: 只能为活动空间打开菜单' });
  });
});

describe('切换进行中或活动空间已变：展示动作丢弃，业务动作仍按冻结空间且不打断切换（O08b / L5）', () => {
  it('同一空间但切换进行中：展示动作丢弃', () => {
    const switching = { ...view('A'), switching: true };
    expect(tabMenuEffect(tab('rename'), switching)).toBeNull();
    expect(newTabMenuEffect({ menuId: 'new-tab', itemId: 'web', target: { workspaceId: 'A' } }, switching)).toBeNull();
    expect(
      runRecordsMenuEffect({ menuId: 'run-records', itemId: 'log', target: { workspaceId: 'A', sessionId: 's' } }, switching),
    ).toBeNull();
    // 业务动作仍按冻结空间执行。
    expect(tabMenuEffect(tab('close-tab'), switching)).toMatchObject({ workspaceId: 'A', payload: { type: 'closeTab' } });
  });

  it('renderer 仍选中原空间但 Main 的活动空间已变：展示动作丢弃', () => {
    const moved = view('A');
    moved.snapshot.activeWorkspaceId = 'B';
    expect(tabMenuEffect(tab('set-group'), moved)).toBeNull();
    expect(
      captureReceiverMenuEffect(
        { menuId: 'capture-receiver', itemId: 'session', target: { workspaceId: 'A', resourceId: 'A-web', sessionId: 's' } },
        moved,
      ),
    ).toBeNull();
  });

  it('navigate: false 的布局命令不开始新的导航（迟到选择不打断进行中的切换）', async () => {
    vi.stubGlobal('window', { studio: { workbench: { command: vi.fn().mockResolvedValue({ ok: true, snapshot: view('A').snapshot }) } } });
    const token = beginNavigation();
    await workspaceCommand('A', { type: 'closeTab', tabId: 'A-t2' }, undefined, { navigate: false });
    expect(isCurrentNavigation(token)).toBe(true);
    await workspaceCommand('A', { type: 'closeTab', tabId: 'A-t2' });
    expect(isCurrentNavigation(token)).toBe(false);
  });
});

describe('renderer 打开菜单：同一时刻一个菜单，先等本空间的待决命令', () => {
  it('连点：第一个菜单未结束时第二次请求不发出；结束（含失败）后标记清除，可再打开', async () => {
    let finish: (value: null) => void = () => undefined;
    const showMenu = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('window', { studio: { shell: { showMenu } } });
    const first = openNativeMenu('new-tab', { workspaceId: 'A' });
    await vi.waitFor(() => expect(showMenu).toHaveBeenCalledTimes(1));
    expect(nativeMenuStore.get().open).toBe('new-tab:A:');
    await expect(openNativeMenu('tab', { workspaceId: 'A', tabId: 'A-t1' })).resolves.toBeNull();
    expect(showMenu).toHaveBeenCalledTimes(1);
    finish(null);
    await expect(first).resolves.toBeNull();
    expect(nativeMenuStore.get().open).toBeNull();
    showMenu.mockRejectedValueOnce(new Error('conflict: 已有菜单打开'));
    await expect(openNativeMenu('new-tab', { workspaceId: 'A' })).resolves.toBeNull();
    expect(nativeMenuStore.get().open).toBeNull();
    expect(showMenu).toHaveBeenCalledTimes(2);
  });

  it('点击触发器前发出的 focusPane 还没有结果时，先等它再请求 Main 菜单（冻结的版本包含它）', async () => {
    projectSnapshot(view('A').snapshot, true);
    workspaceStore.set((s) => ({ ...s, selectedId: 'A' }));
    let reply: (value: unknown) => void = () => undefined;
    const command = vi.fn(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const showMenu = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('window', { studio: { workbench: { command }, shell: { showMenu } } });
    void workspaceCommand('A', { type: 'focusPane', paneId: 'A-p1' });
    const opened = openNativeMenu('pane', { workspaceId: 'A', paneId: 'A-p1' });
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(showMenu).not.toHaveBeenCalled();
    reply({ ok: true, snapshot: { ...view('A').snapshot, seq: 6 } });
    await opened;
    expect(showMenu).toHaveBeenCalledTimes(1);
  });
});
