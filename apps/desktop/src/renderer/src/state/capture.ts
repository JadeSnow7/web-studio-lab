import { workspaceCommand, workspaceStore, beginNavigation, isCurrentNavigation } from './workspace';
import { createStore, useStore } from '../lib/store';
import { reportError } from './errors';
import { shellStore } from './shell';
import { statusPresentationActions } from './status-view';
import {
  autoSessionCleanup,
  autoSessionTitle,
  decideExpansion,
  receiverActions,
  receiverStore,
  resolveDefaultReceiver,
  type Expansion,
} from './capture-receiver';

/*
 * 页面采集（OPS-1 S1，B3）。请求身份、自动新建标记与导航令牌都是展示状态；采集结果只由 Main 写入。
 * - 接收者与页面身份在发起时冻结：requestId 绑定会话，Main 绑定页面（文档代次、webContents）。改接收者只影响之后的采集。
 * - 同一网页发起中的再次触发被忽略（连点、按钮与快捷键同时），只有一个请求、至多一个自动新建会话；采集进行中再次触发即取消。
 * - 完成且用户未导航时按 decideExpansion 有条件展开并把焦点交给接收会话（R9）；否则只在网页状态槽提示。
 * - 取消或失败时，本次自动新建且未使用的会话关闭标签（R8）。
 */

interface Pending {
  workspaceId: string;
  sessionId: string;
  resourceId: string;
  requestId: string;
  /** R8：接收会话由本次采集自动新建（只对这一次请求有效，不持久化）。 */
  autoCreated: boolean;
  unsubscribe: () => void;
}
const requests = new Map<string, Pending>();
export const captureKey = (workspaceId: string, resourceId: string) => JSON.stringify([workspaceId, resourceId]);

/** 展示状态：正在发起（尚未得到 Main 的采集回执）的网页，与进行中请求冻结的接收会话。 */
export const captureStore = createStore<{
  starting: Readonly<Record<string, true>>;
  pending: Readonly<Record<string, string>>;
}>({ starting: {}, pending: {} });
const setStarting = (identity: string, starting: boolean) =>
  captureStore.set((state) => {
    if (!!state.starting[identity] === starting) return state;
    const next = { ...state.starting };
    if (starting) next[identity] = true;
    else delete next[identity];
    return { ...state, starting: next };
  });
const setPending = (identity: string, sessionId: string | null) =>
  captureStore.set((state) => {
    if ((state.pending[identity] ?? null) === sessionId) return state;
    const next = { ...state.pending };
    if (sessionId) next[identity] = sessionId;
    else delete next[identity];
    return { ...state, pending: next };
  });
/** 该网页的采集是否正在发起，以及进行中的请求冻结的接收会话（没有时为 null）。 */
export function useCaptureState(workspaceId: string, resourceId: string) {
  const identity = captureKey(workspaceId, resourceId);
  const starting = useStore(captureStore, (state) => !!state.starting[identity]);
  const pendingSessionId = useStore(captureStore, (state) => state.pending[identity] ?? null);
  return { starting, pendingSessionId };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const latestWorkspace = (workspaceId: string) => workspaceStore.get().snapshot?.workspaces.find((w) => w.workspaceId === workspaceId);

/** R8：关闭本次自动新建且仍未使用的会话标签；这是我们自己的清理，不算用户导航。 */
async function cleanupAutoSession(pending: Pending) {
  if (!pending.autoCreated) return;
  const cleanup = autoSessionCleanup(latestWorkspace(pending.workspaceId), pending.sessionId);
  if (!cleanup) return;
  await workspaceCommand(pending.workspaceId, { type: 'closeTab', tabId: cleanup.tabId }, undefined, { navigate: false });
}

/** 只保存证据并提示：网页状态槽提示通道显示「已采集到 {会话} · 打开」，「打开」定位接收会话。 */
function notifyCaptured(pending: Pending) {
  const title = latestWorkspace(pending.workspaceId)?.sessions.find((s) => s.sessionId === pending.sessionId)?.title ?? '会话';
  statusPresentationActions.hint({
    key: `ui:${pending.resourceId}:captured`,
    scope: { kind: 'resource', workspaceId: pending.workspaceId, resourceId: pending.resourceId },
    label: `已采集到 ${title}`,
    source: 'capture-result',
    until: 'ack',
    action: { id: 'session.open', label: '打开' },
    locate: { workspaceId: pending.workspaceId, sessionId: pending.sessionId },
  });
}

/** 执行展开：所有布局命令带决定时的空间版本（布局已被他处改变时以冲突拒绝，不替换已占用窗格），且不算用户导航。 */
async function applyExpansion(workspaceId: string, revision: number, expansion: Exclude<Expansion, { kind: 'hint' }>) {
  const run = (payload: Parameters<typeof workspaceCommand>[1], expected: number) =>
    workspaceCommand(workspaceId, payload, expected, { navigate: false });
  if (expansion.kind === 'in-place') return (await run({ type: 'focusPane', paneId: expansion.paneId }, revision))?.ok === true;
  if (expansion.kind === 'split')
    return (
      (await run({ type: 'splitPane', paneId: expansion.paneId, direction: 'horizontal', tabId: expansion.tabId }, revision))?.ok === true
    );
  const focused = await run({ type: 'focusPane', paneId: expansion.paneId }, revision);
  if (!focused?.ok) return false;
  const next = focused.snapshot.workspaces.find((w) => w.workspaceId === workspaceId)?.revision;
  if (next === undefined) return false;
  return (await run({ type: 'activateTab', tabId: expansion.tabId }, next))?.ok === true;
}

/** R9：Main 先把键盘焦点从原生网页交回工作台页面，renderer 再聚焦接收会话的输入框；期间用户一旦导航就不再移动焦点。 */
async function focusReceiver(sessionId: string, navigation: number) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await frame();
    if (!isCurrentNavigation(navigation)) return;
    const input = typeof document === 'undefined' ? null : document.getElementById(`draft-${sessionId}`);
    if (!input?.isConnected || input.closest('[hidden]')) continue;
    const focused = await window.studio.shell.focusWorkbench();
    if (!focused || !isCurrentNavigation(navigation)) return;
    input.focus();
    return;
  }
}

async function completeCapture(pending: Pending, navigation: number) {
  receiverActions.record(pending.workspaceId, pending.sessionId);
  const view = workspaceStore.get();
  const workspace = latestWorkspace(pending.workspaceId);
  const shell = shellStore.get();
  const expansion = decideExpansion({
    workspace,
    sessionId: pending.sessionId,
    resourceId: pending.resourceId,
    navigated:
      !isCurrentNavigation(navigation) ||
      view.selectedId !== pending.workspaceId ||
      view.snapshot?.activeWorkspaceId !== pending.workspaceId ||
      shell.route !== 'space',
    narrow: window.innerWidth < 1080 || shell.focusMode,
  });
  if (expansion.kind === 'hint' || !workspace) {
    notifyCaptured(pending);
    return;
  }
  if (!(await applyExpansion(pending.workspaceId, workspace.revision, expansion))) {
    notifyCaptured(pending);
    return;
  }
  await focusReceiver(pending.sessionId, navigation);
}

/**
 * 向 sessionId 发起一次采集（接收者由调用方确定并冻结）。autoCreated 表示接收会话由本次采集自动新建（R8）。
 * 同一网页或同一会话已有的进行中请求被替换（Main 同样以“已被新请求替换”取消旧请求，不转移归属）。
 */
export async function captureContext(workspaceId: string, sessionId: string, resourceId: string, options: { autoCreated?: boolean } = {}) {
  const identity = captureKey(workspaceId, resourceId);
  for (const [existingKey, request] of requests) {
    if (existingKey === identity || (request.workspaceId === workspaceId && request.sessionId === sessionId)) {
      request.unsubscribe();
      requests.delete(existingKey);
      setPending(existingKey, null);
      if (request.sessionId !== sessionId) void cleanupAutoSession(request);
    }
  }
  const requestId = crypto.randomUUID();
  const pending: Pending = {
    workspaceId,
    sessionId,
    resourceId,
    requestId,
    autoCreated: options.autoCreated ?? false,
    unsubscribe: () => {},
  };
  requests.set(identity, pending);
  setPending(identity, sessionId);
  const owned = () => requests.get(identity) === pending;
  const release = () => {
    pending.unsubscribe();
    if (owned()) {
      requests.delete(identity);
      setPending(identity, null);
    }
  };
  const opening = workspaceCommand(workspaceId, { type: 'openTab', resourceId });
  // Opening the capture target is our own navigation; later user navigation revokes only auto-expansion and focus.
  const navigation = beginNavigation();
  const opened = await opening;
  if (!opened?.ok || !owned()) {
    release();
    await cleanupAutoSession(pending);
    return opened;
  }
  // React publishes native bounds from useLayoutEffect before picking starts.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (!owned()) {
    await cleanupAutoSession(pending);
    return null;
  }
  pending.unsubscribe = workspaceStore.subscribe(() => {
    if (!owned()) return;
    const receipt = latestWorkspace(workspaceId)?.sessions.find((s) => s.sessionId === sessionId)?.captureRequest;
    if (receipt?.requestId !== requestId || receipt.resourceId !== resourceId) return;
    if (receipt.state === 'completed') {
      release();
      void completeCapture(pending, navigation).catch((error: unknown) => reportError('展开接收会话', error));
    } else if (receipt.state === 'failed' || receipt.state === 'cancelled') {
      release();
      void cleanupAutoSession(pending);
    }
  });
  const result = await workspaceCommand(workspaceId, { type: 'captureContext', sessionId, resourceId, requestId });
  if (!result?.ok && owned()) {
    release();
    await cleanupAutoSession(pending);
  }
  return result;
}

/** 取消本工作台在该网页发起的采集；本次自动新建且未使用的会话随后关闭标签（R8）。 */
export function cancelContextCapture(workspaceId: string, resourceId: string) {
  const identity = captureKey(workspaceId, resourceId);
  const pending = requests.get(identity);
  if (!pending) throw new Error('当前页面没有由此工作台发起的采集请求');
  pending.unsubscribe();
  requests.delete(identity);
  setPending(identity, null);
  return workspaceCommand(workspaceId, { type: 'cancelCapture', resourceId, requestId: pending.requestId }).then(async (result) => {
    if (result?.ok) await cleanupAutoSession(pending);
    return result;
  });
}

/** 按默认接收者规则确定接收会话；没有时按命名规则新建一个（不占用窗格），并标记为本次自动新建。 */
async function receiverFor(workspaceId: string, resourceId: string): Promise<{ sessionId: string; autoCreated: boolean } | null> {
  const workspace = latestWorkspace(workspaceId);
  if (!workspace) return null;
  const receiver = resolveDefaultReceiver({
    workspace,
    resourceId,
    explicitSessionId: receiverActions.explicit(workspaceId, resourceId),
    activity: receiverStore.get().activity[workspaceId] ?? {},
  });
  if (receiver.sessionId) return { sessionId: receiver.sessionId, autoCreated: false };
  const sessionId = await createReceiverSession(workspaceId, resourceId);
  return sessionId ? { sessionId, autoCreated: true } : null;
}

/**
 * 新建一个接收会话（命名「{网页标题} · 会话」），只新建标签、不改变布局；返回新会话身份。
 * 采集发起时的自动新建与接收者菜单的「新建会话」共用。
 */
export async function createReceiverSession(workspaceId: string, resourceId: string): Promise<string | null> {
  const before = latestWorkspace(workspaceId);
  const resource = before?.resources.find((r) => r.resourceId === resourceId);
  if (!before || !resource) return null;
  const known = new Set(before.sessions.map((s) => s.sessionId));
  const result = await workspaceCommand(
    workspaceId,
    { type: 'createTab', kind: 'session', title: autoSessionTitle(resource), activate: false },
    undefined,
    { navigate: false },
  );
  if (!result?.ok) return null;
  const created = result.snapshot.workspaces.find((w) => w.workspaceId === workspaceId)?.sessions.find((s) => !known.has(s.sessionId));
  if (!created) throw new Error('新建会话成功但未返回会话身份');
  return created.sessionId;
}

/**
 * 取消该网页进行中的点选（再次点击「选择元素」、Esc、状态槽「取消采集」）；从不发起新的采集。
 * 本工作台发起的请求按 requestId 取消；Main 在选择而本工作台没有对应请求时（如重新加载前发起）取消页面里的选择。
 * 返回是否有可取消的点选。
 */
export async function cancelCapture(workspaceId: string, resourceId: string): Promise<boolean> {
  if (!cancellable(workspaceId, resourceId)) return false;
  if (requests.has(captureKey(workspaceId, resourceId))) await cancelContextCapture(workspaceId, resourceId);
  else await workspaceCommand(workspaceId, { type: 'browserAction', resourceId, action: 'cancelPick' });
  return true;
}
const cancellable = (workspaceId: string, resourceId: string) =>
  requests.has(captureKey(workspaceId, resourceId)) ||
  !!latestWorkspace(workspaceId)?.resources.find((r) => r.resourceId === resourceId)?.preview?.picking;

/**
 * 「选择元素」（以及之后的快捷键）的唯一入口：没有进行中的采集时按默认接收者发起；进行中再次触发即取消；
 * 发起尚未得到回执时的重复触发被忽略。Main 在选择而本工作台没有对应请求时（如重新加载前发起）取消页面里的选择。
 */
export async function toggleCapture(workspaceId: string, resourceId: string): Promise<void> {
  const identity = captureKey(workspaceId, resourceId);
  if (captureStore.get().starting[identity]) return;
  if (cancellable(workspaceId, resourceId)) {
    await cancelCapture(workspaceId, resourceId);
    return;
  }
  // 在第一个 await 之前占位：同一轮里的重复触发（连点、按钮与快捷键同时）都在这里被忽略。
  setStarting(identity, true);
  try {
    const receiver = await receiverFor(workspaceId, resourceId);
    if (!receiver) return;
    await captureContext(workspaceId, receiver.sessionId, resourceId, { autoCreated: receiver.autoCreated });
  } finally {
    setStarting(identity, false);
  }
}
