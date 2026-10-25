import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import type {
  PreviewState,
  ShowMenuRequest,
  WorkbenchResource,
  WorkbenchSession,
  WorkbenchSnapshot,
  WorkspaceSnapshot,
} from '@wsl/protocol';
import { NativeMenuService, type NativeMenuHost, type NativeMenuPopupOptions } from './native-menu';

/*
 * OPS-1 S5 / O08a / O08b：Main 按自己的快照构建原生菜单，经 Menu.popup() 展示，返回选择项与冻结目标，取消返回 null。
 * 这里用假的宿主记录模板与弹出选项，由测试按真实系统可能的顺序触发 click 与关闭回调。
 */

const preview = (patch: Partial<PreviewState> = {}): PreviewState => ({
  page: { webContentsId: 7, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: 'TaskFlow', partition: 'p' },
  loading: false,
  canGoBack: false,
  canGoForward: false,
  picking: false,
  cdp: { state: 'attached' },
  consoleIssueCount: 0,
  loadError: null,
  blockedNavigation: null,
  pickError: null,
  ...patch,
});
const resource = (resourceId: string, kind: WorkbenchResource['kind'], patch: Partial<WorkbenchResource> = {}): WorkbenchResource => ({
  resourceId,
  environmentId: kind === 'web' ? 'local' : null,
  kind,
  title: resourceId,
  url: kind === 'web' ? 'wsl-demo://taskflow/index.html' : null,
  instanceId: kind === 'web' ? `inst-${resourceId}` : null,
  generation: 1,
  preview: kind === 'web' ? preview() : null,
  terminal: null,
  unavailableReason: null,
  ...patch,
});
const session = (sessionId: string, resourceId: string, title: string): WorkbenchSession => ({
  sessionId,
  resourceId,
  title,
  draft: '',
  conversation: null,
  historyRestored: false,
  observations: [],
  context: null,
  captureRequest: null,
  contextTarget: null,
  taskTargetRef: null,
  taskAcceptance: [],
  taskAllowedScopes: [],
  contextApplicability: 'unknown',
  taskVersions: [],
  harnessSelection: null,
  taskProject: null,
  taskProjectDecided: false,
});
/** 空间 A：网页 web-a（左窗格）、会话 s-a1（右窗格）与会话 s-a2（未显示）；空间 B：网页 web-b、会话 s-b。 */
const workspaceA = (): WorkspaceSnapshot => ({
  workspaceId: 'A',
  name: '空间 A',
  revision: 12,
  tabs: [
    { tabId: 'tab-web-a', title: '网页 A', pinned: false, group: null, targetRef: { kind: 'web', resourceId: 'web-a' }, autoTitle: false },
    {
      tabId: 'tab-s-a1',
      title: '会话一',
      pinned: true,
      group: '组',
      targetRef: { kind: 'session', resourceId: 'r-s-a1' },
      autoTitle: false,
    },
    {
      tabId: 'tab-s-a2',
      title: '会话二',
      pinned: false,
      group: null,
      targetRef: { kind: 'session', resourceId: 'r-s-a2' },
      autoTitle: false,
    },
  ],
  resources: [resource('web-a', 'web'), resource('r-s-a1', 'session'), resource('r-s-a2', 'session')],
  layout: {
    kind: 'split',
    direction: 'horizontal',
    ratio: 0.3,
    first: { kind: 'pane', paneId: 'pane-a1', tabId: 'tab-web-a' },
    second: { kind: 'pane', paneId: 'pane-a2', tabId: 'tab-s-a1' },
  },
  activePaneId: 'pane-a2',
  sessions: [session('s-a1', 'r-s-a1', '会话一'), session('s-a2', 'r-s-a2', '会话二')],
  runs: [],
  fileHints: [],
  observations: [],
  theme: 'light',
});
const workspaceB = (): WorkspaceSnapshot => ({
  workspaceId: 'B',
  name: '空间 B',
  revision: 3,
  tabs: [
    { tabId: 'tab-web-b', title: '网页 B', pinned: false, group: null, targetRef: { kind: 'web', resourceId: 'web-b' }, autoTitle: false },
    {
      tabId: 'tab-s-b',
      title: '会话 B',
      pinned: false,
      group: null,
      targetRef: { kind: 'session', resourceId: 'r-s-b' },
      autoTitle: false,
    },
  ],
  resources: [resource('web-b', 'web'), resource('r-s-b', 'session')],
  layout: { kind: 'pane', paneId: 'pane-b', tabId: 'tab-web-b' },
  activePaneId: 'pane-b',
  sessions: [session('s-b', 'r-s-b', '会话 B')],
  runs: [],
  fileHints: [],
  observations: [],
  theme: 'light',
});
const snapshotOf = (...workspaces: WorkspaceSnapshot[]): WorkbenchSnapshot => ({
  appInstanceId: 'app',
  storageError: null,
  activeWorkspaceId: workspaces[0]!.workspaceId,
  seq: 1,
  workspaces,
  environments: [],
  notificationReadReceipts: [],
  notifications: [],
});

type Popup = { template: MenuItemConstructorOptions[]; options: NativeMenuPopupOptions };
function harness(
  snapshot: WorkbenchSnapshot = snapshotOf(workspaceA(), workspaceB()),
  size = { width: 1440, height: 900 },
  read: (snapshot: WorkbenchSnapshot) => Promise<WorkbenchSnapshot> = async (value) => structuredClone(value),
) {
  const popups: Popup[] = [];
  const invalidated: Array<() => void> = [];
  const closed = vi.fn();
  const host: NativeMenuHost = {
    contentSize: () => size,
    popup: (template, options) => {
      popups.push({ template, options });
    },
    close: closed,
    onInvalidated: (listener) => invalidated.push(listener),
  };
  const service = new NativeMenuService({ host, snapshot: () => read(snapshot) });
  const items = (index = popups.length - 1) =>
    (popups[index]?.template ?? [])
      .filter((item) => item.type !== 'separator')
      .map((item) => ({ label: item.label, enabled: item.enabled }));
  /** 窗口关闭、页面重新加载或 renderer 退出。 */
  const invalidate = () => invalidated.forEach((listener) => listener());
  const item = (label: string, index = popups.length - 1) => {
    const found = popups[index]?.template.find((entry) => entry.label === label);
    if (!found?.click) throw new Error(`菜单项不存在：${label}`);
    return () => (found.click as () => void)();
  };
  const close = (index = popups.length - 1) => popups[index]!.options.callback();
  /** 等 show() 走完异步快照读取、真正调用 popup。 */
  const opened = async (count = 1) => {
    await vi.waitFor(() => expect(popups.length).toBe(count));
  };
  return { service, popups, items, item, close, opened, snapshot, invalidate, closed };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settledWithin = async <T>(promise: Promise<T>) => {
  const marker = Symbol('pending');
  return Promise.race([
    promise,
    tick()
      .then(() => tick())
      .then(() => marker),
  ]).then((value) => (value === marker ? 'pending' : value));
};
const request = (value: unknown) => value as ShowMenuRequest;

describe('原生菜单时序（R3 / O08a）', () => {
  it('选择由菜单项 click 决定：返回 itemId 与 Main 冻结的目标', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-s-a2' } });
    await h.opened();
    h.item('在右侧打开')();
    h.close();
    await expect(result).resolves.toEqual({
      menuId: 'tab',
      itemId: 'open-right',
      target: { workspaceId: 'A', tabId: 'tab-s-a2', paneId: 'pane-a2', revision: 12 },
    });
  });

  it('macOS 上关闭回调早于 click：仍得到所选项，而不是 null', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'pane', context: { workspaceId: 'A', paneId: 'pane-a1' } });
    await h.opened();
    h.close();
    // 关闭回调之后、同一轮事件里才到达的 click。
    h.item('平均分割')();
    await expect(result).resolves.toEqual({
      menuId: 'pane',
      itemId: 'equalize',
      target: { workspaceId: 'A', paneId: 'pane-a1', revision: 12 },
    });
  });

  it('只有关闭回调（Esc / 点外部）：延后一个 tick 才判定为 null，不在回调里同步判定', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
    let resolved: unknown = 'pending';
    void result.then((value) => (resolved = value));
    h.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe('pending');
    await expect(result).resolves.toBeNull();
  });

  it('结果只决定一次：click 之后的再次 click、关闭回调都不改变结果', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'run-records', context: { workspaceId: 'A', sessionId: 's-a1' } });
    await h.opened();
    h.item('diff')();
    h.item('报告')();
    h.close();
    await tick();
    await expect(result).resolves.toMatchObject({ itemId: 'diff' });
  });

  it('没有任何回调前保持未决：不因超时或 popup 返回而自行判定', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
    expect(await settledWithin(result)).toBe('pending');
  });

  it.each([
    ['越界的右下角', { x: 5000, y: 4000, width: 0, height: 0 }, { x: 1439, y: 899 }],
    ['负坐标', { x: -40, y: -10, width: 0, height: 0 }, { x: 0, y: 0 }],
    ['键盘打开：焦点元素矩形的左下角', { x: 100.4, y: 200.6, width: 80, height: 30 }, { x: 100, y: 231 }],
    ['矩形底边越界', { x: 10, y: 880, width: 40, height: 40 }, { x: 10, y: 899 }],
  ])('坐标限制在窗口内容区内（%s）', async (_name, anchor, expected) => {
    const h = harness();
    void h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A', anchor } });
    await h.opened();
    expect(h.popups[0]!.options).toMatchObject(expected);
  });

  it('没有锚点时不传坐标，由系统放在指针处', async () => {
    const h = harness();
    void h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
    expect(h.popups[0]!.options.x).toBeUndefined();
    expect(h.popups[0]!.options.y).toBeUndefined();
  });
});

describe('菜单内容来自 Main 快照（O08 / O08b）', () => {
  it('标签菜单：条目与 UX 合同一致，没有「关闭菜单」；置顶文字随 Main 状态变化', async () => {
    const h = harness();
    void h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-s-a2' } });
    await h.opened();
    expect(h.items().map((entry) => entry.label)).toEqual([
      '置顶标签',
      '重命名',
      '设置分组',
      '移出分组',
      '向上移动',
      '向下移动',
      '在右侧打开',
      '在下方打开',
      '关闭标签（保留后台执行）',
    ]);
    h.close();
    await tick();
    void h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-s-a1' } });
    await h.opened(2);
    expect(h.items(1)[0]!.label).toBe('取消置顶');
  });

  it('标签菜单的禁用项由 Main 推导：首个不能上移、末个不能下移、无分组不能移出、已显示的标签不能再在旁边打开', async () => {
    const h = harness();
    void h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-web-a' } });
    await h.opened();
    const first = Object.fromEntries(h.items().map((entry) => [entry.label, entry.enabled]));
    expect(first).toMatchObject({ 向上移动: false, 向下移动: true, 移出分组: false, 在右侧打开: false, 在下方打开: false });
    h.close();
    await tick();
    void h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-s-a2' } });
    await h.opened(2);
    const last = Object.fromEntries(h.items(1).map((entry) => [entry.label, entry.enabled]));
    expect(last).toMatchObject({ 向上移动: true, 向下移动: false, 在右侧打开: true, 在下方打开: true });
  });

  it('窗格菜单：四窗格时分屏禁用，点击禁用项不产生选择；单窗格时平均分割与关闭窗格禁用', async () => {
    const four = workspaceA();
    four.layout = {
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { kind: 'pane', paneId: 'p1', tabId: 'tab-web-a' },
        second: { kind: 'pane', paneId: 'p2', tabId: null },
      },
      second: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { kind: 'pane', paneId: 'p3', tabId: 'tab-s-a1' },
        second: { kind: 'pane', paneId: 'p4', tabId: null },
      },
    };
    four.activePaneId = 'p1';
    const h = harness(snapshotOf(four));
    const result = h.service.show({ menuId: 'pane', context: { workspaceId: 'A', paneId: 'p2' } });
    await h.opened();
    expect(h.items()).toEqual([
      { label: '左右分屏', enabled: false },
      { label: '上下分屏', enabled: false },
      { label: '平均分割', enabled: true },
      { label: '关闭窗格（标签保留）', enabled: true },
    ]);
    h.item('左右分屏')();
    h.close();
    await expect(result).resolves.toBeNull();

    const single = workspaceB();
    const s = harness(snapshotOf(single));
    void s.service.show({ menuId: 'pane', context: { workspaceId: 'B', paneId: 'pane-b' } });
    await s.opened();
    expect(Object.fromEntries(s.items().map((entry) => [entry.label, entry.enabled]))).toEqual({
      左右分屏: true,
      上下分屏: true,
      平均分割: false,
      '关闭窗格（标签保留）': false,
    });
  });

  it('⋯ 更多网页操作：普通网页三项，受管 App 网页只有「管理 App」；无实例时「保存正文快照」禁用', async () => {
    const plain = harness();
    void plain.service.show({ menuId: 'web-more', context: { workspaceId: 'A', resourceId: 'web-a' } });
    await plain.opened();
    expect(plain.items()).toEqual([
      { label: '收藏到资源', enabled: true },
      { label: '保存正文快照', enabled: true },
      { label: '查看空间资源', enabled: true },
    ]);
    const stopped = workspaceA();
    stopped.resources[0] = resource('web-a', 'web', { instanceId: null, preview: null });
    const h = harness(snapshotOf(stopped));
    void h.service.show({ menuId: 'web-more', context: { workspaceId: 'A', resourceId: 'web-a' } });
    await h.opened();
    expect(h.items()[1]).toEqual({ label: '保存正文快照', enabled: false });
    const app = workspaceA();
    app.resources[0] = resource('web-a', 'web', { appProjectId: '0b9a3f86-5f43-4c55-9a0c-8b7e7f7f7f7f' });
    const a = harness(snapshotOf(app));
    void a.service.show({ menuId: 'web-more', context: { workspaceId: 'A', resourceId: 'web-a' } });
    await a.opened();
    expect(a.items()).toEqual([{ label: '管理 App', enabled: true }]);
  });

  it('采集接收者菜单（OPS-1 S1）：列出本空间标签仍打开的会话（不含他空间、不含已关闭标签的会话）与新建会话；有接收会话时以单选标出它并提供「打开接收会话」', async () => {
    const withClosed = workspaceA();
    // 标签已关闭的会话仍在空间里（后台资源），但不能作为接收者：不出现在菜单中。
    withClosed.resources.push(resource('r-s-a3', 'session'));
    withClosed.sessions.push(session('s-a3', 'r-s-a3', '已关闭的会话'));
    const h = harness(snapshotOf(withClosed, workspaceB()));
    const result = h.service.show({
      menuId: 'capture-receiver',
      context: { workspaceId: 'A', resourceId: 'web-a', receiverSessionId: null },
    });
    await h.opened();
    expect(h.items().map((entry) => entry.label)).toEqual(['会话一', '会话二', '新建会话']);
    h.item('会话二')();
    await expect(result).resolves.toEqual({
      menuId: 'capture-receiver',
      itemId: 'session',
      target: { workspaceId: 'A', resourceId: 'web-a', sessionId: 's-a2' },
    });
    const withReceiver = h.service.show({
      menuId: 'capture-receiver',
      context: { workspaceId: 'A', resourceId: 'web-a', receiverSessionId: 's-a1' },
    });
    await h.opened(2);
    expect(h.items(1).map((entry) => entry.label)).toEqual(['会话一', '会话二', '新建会话', '打开接收会话']);
    expect(h.popups[1]!.template.filter((entry) => entry.type === 'radio').map((entry) => [entry.label, entry.checked])).toEqual([
      ['会话一', true],
      ['会话二', false],
    ]);
    h.item('打开接收会话', 1)();
    await expect(withReceiver).resolves.toMatchObject({ itemId: 'open-receiver', target: { sessionId: 's-a1' } });
  });

  it.each([
    ['加载中', { preview: preview({ loading: true }) }],
    ['没有网页实例', { instanceId: null, preview: null }],
    ['点选进行中', { preview: preview({ picking: true }) }],
  ] as const)('采集接收者菜单：选择只设定之后采集的接收者、不开始采集，网页%s时条目仍可用（OPS-1 S1）', async (_name, patch) => {
    const blocked = workspaceA();
    blocked.resources[0] = resource('web-a', 'web', patch);
    const h = harness(snapshotOf(blocked));
    void h.service.show({ menuId: 'capture-receiver', context: { workspaceId: 'A', resourceId: 'web-a', receiverSessionId: 's-a1' } });
    await h.opened();
    expect(h.items()).toEqual([
      { label: '会话一', enabled: true },
      { label: '会话二', enabled: true },
      { label: '新建会话', enabled: true },
      { label: '打开接收会话', enabled: true },
    ]);
  });

  it('标签菜单：四窗格时「在右侧打开」「在下方打开」禁用（与窗格菜单的分屏上限一致）', async () => {
    const four = workspaceA();
    four.layout = {
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { kind: 'pane', paneId: 'p1', tabId: 'tab-web-a' },
        second: { kind: 'pane', paneId: 'p2', tabId: null },
      },
      second: {
        kind: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { kind: 'pane', paneId: 'p3', tabId: 'tab-s-a1' },
        second: { kind: 'pane', paneId: 'p4', tabId: null },
      },
    };
    four.activePaneId = 'p2';
    const h = harness(snapshotOf(four));
    const result = h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-s-a2' } });
    await h.opened();
    expect(Object.fromEntries(h.items().map((entry) => [entry.label, entry.enabled]))).toMatchObject({
      在右侧打开: false,
      在下方打开: false,
    });
    h.item('在右侧打开')();
    h.close();
    await expect(result).resolves.toBeNull();
  });

  it('标签菜单的目标窗格是 Main 的活动窗格（不是最后一个窗格）', async () => {
    const first = workspaceA();
    first.activePaneId = 'pane-a1';
    const h = harness(snapshotOf(first));
    const result = h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-s-a2' } });
    await h.opened();
    h.item('在下方打开')();
    await expect(result).resolves.toMatchObject({ itemId: 'open-below', target: { paneId: 'pane-a1' } });
  });

  it('新建标签：列出全部既有类型', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
    expect(h.items().map((entry) => entry.label)).toEqual(['网页', '终端', 'Agent 会话', '文件', 'SSH']);
    h.item('文件')();
    await expect(result).resolves.toEqual({ menuId: 'new-tab', itemId: 'file', target: { workspaceId: 'A' } });
  });

  it('运行记录：日志 / diff / 报告，目标是所属会话', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'run-records', context: { workspaceId: 'A', sessionId: 's-a2' } });
    await h.opened();
    expect(h.items().map((entry) => entry.label)).toEqual(['日志', 'diff', '报告']);
    h.item('日志')();
    await expect(result).resolves.toEqual({ menuId: 'run-records', itemId: 'log', target: { workspaceId: 'A', sessionId: 's-a2' } });
  });

  it('运行记录：上下文给出当前视图时以单选项标出当前项；没有时都不标', async () => {
    const h = harness();
    void h.service.show({ menuId: 'run-records', context: { workspaceId: 'A', sessionId: 's-a2', current: 'diff' } });
    await h.opened();
    expect(h.popups[0]!.template.map((entry) => [entry.label, entry.type, entry.checked])).toEqual([
      ['日志', 'radio', false],
      ['diff', 'radio', true],
      ['报告', 'radio', false],
    ]);
    h.close();
    await tick();
    void h.service.show({ menuId: 'run-records', context: { workspaceId: 'A', sessionId: 's-a2' } });
    await h.opened(2);
    expect(h.popups[1]!.template.every((entry) => entry.checked === false)).toBe(true);
  });

  it('菜单读取的是请求时的 Main 快照：显示标签名不由 renderer 提供', async () => {
    const h = harness();
    // 多余的 label 字段在 IPC 边界被 schema 拒绝（见 ipc-native-menu.test.ts）；这里确认菜单文字只来自快照。
    void h.service.show({ menuId: 'capture-receiver', context: { workspaceId: 'A', resourceId: 'web-a', receiverSessionId: null } });
    await h.opened();
    expect(h.items().map((entry) => entry.label)).not.toContain('会话 B');
  });
});

describe('非法菜单请求（O08b）：拒绝且不显示菜单', () => {
  it.each([
    ['未知空间', { menuId: 'new-tab', context: { workspaceId: 'Z' } }, /not_found/],
    ['后台空间', { menuId: 'new-tab', context: { workspaceId: 'B' } }, /denied/],
    ['他空间标签', { menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-web-b' } }, /denied/],
    ['未知标签', { menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-missing' } }, /not_found/],
    ['他空间窗格', { menuId: 'pane', context: { workspaceId: 'A', paneId: 'pane-b' } }, /denied/],
    ['未知窗格', { menuId: 'pane', context: { workspaceId: 'A', paneId: 'pane-missing' } }, /not_found/],
    ['他空间会话', { menuId: 'run-records', context: { workspaceId: 'A', sessionId: 's-b' } }, /denied/],
    ['他空间网页', { menuId: 'web-more', context: { workspaceId: 'A', resourceId: 'web-b' } }, /denied/],
    ['不是网页的资源', { menuId: 'web-more', context: { workspaceId: 'A', resourceId: 'r-s-a1' } }, /not_found/],
    [
      '采集目标是他空间网页',
      { menuId: 'capture-receiver', context: { workspaceId: 'A', resourceId: 'web-b', receiverSessionId: null } },
      /denied/,
    ],
    [
      '关联会话属于他空间',
      { menuId: 'capture-receiver', context: { workspaceId: 'A', resourceId: 'web-a', receiverSessionId: 's-b' } },
      /denied/,
    ],
  ])('%s', async (_name, value, error) => {
    const h = harness();
    await expect(h.service.show(request(value))).rejects.toThrow(error);
    expect(h.popups).toHaveLength(0);
  });
});

describe('R3 取消只在一个宏任务之后判定（假定时器）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const flushMicrotasks = async (rounds = 50) => {
    for (let index = 0; index < rounds; index++) await Promise.resolve();
  };

  it('关闭回调先到、微任务全部执行完之后 click 才到（仍早于延后的 tick）：结果是该菜单项', async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolved: unknown = 'pending';
    const result = h.service.show({ menuId: 'pane', context: { workspaceId: 'A', paneId: 'pane-a1' } });
    void result.then((value) => (resolved = value));
    await flushMicrotasks();
    expect(h.popups).toHaveLength(1);
    h.close();
    await flushMicrotasks();
    expect(resolved).toBe('pending');
    h.item('上下分屏')();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ itemId: 'split-below' });
  });

  it('只有关闭回调：任意多的微任务之后仍未决，推进定时器后才是 null；之后迟到的 click 不改变结果', async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolved: unknown = 'pending';
    const result = h.service.show({ menuId: 'pane', context: { workspaceId: 'A', paneId: 'pane-a1' } });
    void result.then((value) => (resolved = value));
    await flushMicrotasks();
    h.close();
    await flushMicrotasks(200);
    expect(resolved).toBe('pending');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBeNull();
    h.item('上下分屏')();
    await flushMicrotasks();
    await expect(result).resolves.toBeNull();
  });
});

describe('每个窗口一个菜单与失效（O08b / 活性）', () => {
  it('前一个菜单未决时再请求：以 conflict 拒绝且不弹出；前一个结束后可再打开', async () => {
    const h = harness();
    const first = h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
    await expect(h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'tab-web-a' } })).rejects.toThrow(/conflict/);
    expect(h.popups).toHaveLength(1);
    h.item('终端')();
    await expect(first).resolves.toMatchObject({ itemId: 'terminal' });
    void h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened(2);
  });

  it('非法请求被拒绝后不占用：下一次请求照常打开', async () => {
    const h = harness();
    await expect(h.service.show(request({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'nope' } }))).rejects.toThrow(/not_found/);
    void h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
  });

  it('窗口关闭 / 页面重新加载 / renderer 退出：仍打开的菜单被关闭，请求以 null 结束，之后的 click 无效，可再打开', async () => {
    const h = harness();
    const result = h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened();
    h.invalidate();
    expect(h.closed).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toBeNull();
    h.item('网页')();
    await expect(result).resolves.toBeNull();
    void h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened(2);
  });

  it('读取快照期间失效：不弹出菜单，请求以 null 结束', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(snapshotOf(workspaceA()), { width: 1440, height: 900 }, async (value) => {
      await gate;
      return structuredClone(value);
    });
    const result = h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    h.invalidate();
    release();
    await expect(result).resolves.toBeNull();
    expect(h.popups).toHaveLength(0);
  });

  it('选择无法通过协议校验时请求被拒绝（不会永远未决），菜单随即可再打开', async () => {
    const long = workspaceA();
    long.tabs[2] = { ...long.tabs[2]!, tabId: 'x'.repeat(201) };
    const h = harness(snapshotOf(long));
    const result = h.service.show({ menuId: 'tab', context: { workspaceId: 'A', tabId: 'x'.repeat(201) } });
    await h.opened();
    h.item('重命名')();
    await expect(result).rejects.toThrow();
    void h.service.show({ menuId: 'new-tab', context: { workspaceId: 'A' } });
    await h.opened(2);
  });
});
