import type { PageCapture, PaneLayout, WorkbenchSession, WorkspaceSnapshot } from '@wsl/protocol';
import { createStore, useStore } from '../lib/store';
import { reportError } from './errors';

/*
 * OPS-1 S1 / S2（B3）的纯规则：默认接收者、采集完成后的条件展开、R8 自动会话清理与单一任务目标的展示。
 * 输入是 Main 快照的投影与本设备的展示偏好（显式接收者、最近活动）；业务状态仍只由 Main 写入。
 */

type Pane = Extract<PaneLayout, { kind: 'pane' }>;
const leaves = (layout: PaneLayout): Pane[] => (layout.kind === 'pane' ? [layout] : [...leaves(layout.first), ...leaves(layout.second)]);
const tabOf = (workspace: WorkspaceSnapshot, resourceId: string) => workspace.tabs.find((tab) => tab.targetRef.resourceId === resourceId);

/** 自动新建的接收会话名称：沿用此前「新建会话」的命名规则（网页标签标题 · 会话）。 */
export const autoSessionTitle = (resource: { title: string }) => `${resource.title} · 会话`;

export type DefaultReceiver =
  | { rule: 'explicit' | 'pending' | 'same-screen' | 'space'; sessionId: string; title: string }
  | { rule: 'auto'; sessionId: null; title: string };

/**
 * 默认接收者（O02a）：① 显式选择且仍有效（会话存在、标签仍打开）；② 与该网页同屏（在当前布局的某个窗格中）且最近活动的会话，
 * 多个都没有活动记录时按窗格顺序取第一个；③ 本空间标签仍打开、有活动记录中最近的会话；④ 都没有时在发起时自动新建。
 * pendingSessionId 是此网页正在进行的采集冻结的接收者：没有新的显式选择时按它显示，采集进行中按钮不跳变。
 * 活动记录只是本设备的展示偏好，每次使用都对照当前快照（已不存在或标签已关闭的会话不参与）。
 */
export function resolveDefaultReceiver({
  workspace,
  resourceId,
  explicitSessionId,
  pendingSessionId = null,
  activity,
}: {
  workspace: WorkspaceSnapshot;
  resourceId: string;
  explicitSessionId: string | null;
  pendingSessionId?: string | null;
  activity: Readonly<Record<string, number>>;
}): DefaultReceiver {
  const open = workspace.sessions.filter((session) => tabOf(workspace, session.resourceId));
  const find = (sessionId: string | null) => (sessionId ? open.find((session) => session.sessionId === sessionId) : undefined);
  const pick = (rule: Exclude<DefaultReceiver['rule'], 'auto'>, session: WorkbenchSession) => ({
    rule,
    sessionId: session.sessionId,
    title: session.title,
  });
  const explicit = find(explicitSessionId);
  if (explicit) return pick('explicit', explicit);
  const pending = find(pendingSessionId);
  if (pending) return pick('pending', pending);
  const recent = (candidates: WorkbenchSession[]) =>
    candidates
      .filter((session) => typeof activity[session.sessionId] === 'number')
      .reduce<WorkbenchSession | undefined>(
        (best, session) => (!best || activity[session.sessionId]! > activity[best.sessionId]! ? session : best),
        undefined,
      );
  const onScreen = leaves(workspace.layout).flatMap((pane) => {
    const session = pane.tabId ? open.find((item) => tabOf(workspace, item.resourceId)?.tabId === pane.tabId) : undefined;
    return session ? [session] : [];
  });
  const screen = recent(onScreen) ?? onScreen[0];
  if (screen) return pick('same-screen', screen);
  const space = recent(open);
  if (space) return pick('space', space);
  const resource = workspace.resources.find((item) => item.resourceId === resourceId);
  return { rule: 'auto', sessionId: null, title: autoSessionTitle(resource ?? { title: '网页' }) };
}

export type Expansion =
  | { kind: 'in-place'; paneId: string }
  | { kind: 'empty-pane'; paneId: string; tabId: string }
  | { kind: 'split'; paneId: string; tabId: string }
  | { kind: 'hint'; reason: 'navigated' | 'narrow' | 'full' | 'receiver-closed' | 'source-hidden' };

const MAX_PANES = 4;

/**
 * 采集完成后的条件展开（O04a，D4）。用户已导航（含切换空间、离开空间页）或空间不在时不改布局；窄窗（或只投影活动窗格的专注模式）同样只提示。
 * 否则：接收会话已在某窗格可见 → 原位更新；有空窗格 → 放入空窗格；未满四窗格 → 在源网页窗格旁分屏；四窗格已满 → 只提示。
 * 接收会话标签已关闭时只提示，不重开、不新建（O03b）；源网页已不在任何窗格时没有可并排的位置，只提示。从不替换已占用的窗格。
 */
export function decideExpansion({
  workspace,
  sessionId,
  resourceId,
  navigated,
  narrow,
}: {
  workspace: WorkspaceSnapshot | undefined;
  sessionId: string;
  resourceId: string;
  navigated: boolean;
  narrow: boolean;
}): Expansion {
  if (navigated || !workspace) return { kind: 'hint', reason: 'navigated' };
  if (narrow) return { kind: 'hint', reason: 'narrow' };
  const session = workspace.sessions.find((item) => item.sessionId === sessionId);
  const tab = session ? tabOf(workspace, session.resourceId) : undefined;
  if (!tab) return { kind: 'hint', reason: 'receiver-closed' };
  const panes = leaves(workspace.layout);
  const visible = panes.find((pane) => pane.tabId === tab.tabId);
  if (visible) return { kind: 'in-place', paneId: visible.paneId };
  const empty = panes.find((pane) => pane.tabId === null);
  if (empty) return { kind: 'empty-pane', paneId: empty.paneId, tabId: tab.tabId };
  if (panes.length >= MAX_PANES) return { kind: 'hint', reason: 'full' };
  const source = tabOf(workspace, resourceId);
  const sourcePane = source ? panes.find((pane) => pane.tabId === source.tabId) : undefined;
  if (!sourcePane) return { kind: 'hint', reason: 'source-hidden' };
  return { kind: 'split', paneId: sourcePane.paneId, tabId: tab.tabId };
}

/**
 * R8：本次采集自动新建的会话在采集取消（或失败）后，若仍未使用（没有消息、草稿、任务版本、运行与采集证据）则关闭它的标签。
 * 现有命令不能移除会话本身：会话留在空间的后台资源里，只关闭标签。
 */
export function autoSessionCleanup(workspace: WorkspaceSnapshot | undefined, sessionId: string): { tabId: string } | null {
  const session = workspace?.sessions.find((item) => item.sessionId === sessionId);
  if (!workspace || !session) return null;
  const used =
    !!session.conversation?.messages.length ||
    !!session.draft.trim() ||
    session.taskVersions.length > 0 ||
    session.context !== null ||
    workspace.runs.some((run) => run.sessionId === sessionId);
  if (used) return null;
  const tab = tabOf(workspace, session.resourceId);
  return tab ? { tabId: tab.tabId } : null;
}

const REFERENCE_TEXT_LIMIT = 40;
/** 引用标签：`{元素文字或标签名} · {页面标题}`。 */
export function referenceLabel(capture: PageCapture): string {
  const text = capture.element.text.replace(/\s+/g, ' ').trim();
  const subject = text ? (text.length > REFERENCE_TEXT_LIMIT ? `${text.slice(0, REFERENCE_TEXT_LIMIT)}…` : text) : capture.element.tagName;
  return `${subject} · ${capture.page.title}`;
}

export type TaskReference =
  | { kind: 'none' }
  | { kind: 'page'; resourceId: string; capture: PageCapture | null; label: string }
  | { kind: 'resource'; resourceId: string; title: string };

/**
 * 单一任务目标（§9.1）的展示：网页目标显示为输入框上方的引用标签（有该页的采集时带元素与截图），文件 / 终端 / SSH 目标属于任务设置。
 * 最后一次显式操作决定 `taskTargetRef`（Main 在采集完成时写入网页目标，任务设置写入其他目标），始终可见。
 */
export function taskReference(workspace: WorkspaceSnapshot, session: WorkbenchSession): TaskReference {
  const target = session.taskTargetRef;
  if (!target) return { kind: 'none' };
  const resource = workspace.resources.find((item) => item.resourceId === target.resourceId);
  if (target.kind !== 'web') return { kind: 'resource', resourceId: target.resourceId, title: resource?.title ?? '已移除的资源' };
  const capture = session.context && session.contextTarget?.resourceId === target.resourceId ? session.context : null;
  return {
    kind: 'page',
    resourceId: target.resourceId,
    capture,
    label: capture ? referenceLabel(capture) : `${resource?.title ?? '网页'} · 未选择元素`,
  };
}

/** 「任务设置」折叠时的摘要，如“范围 1 · 验收 2 · 开发终端”。 */
export function taskSettingsSummary({ scopes, acceptance, target }: { scopes: number; acceptance: number; target: string | null }): string {
  return [`范围 ${scopes}`, `验收 ${acceptance}`, ...(target ? [target] : [])].join(' · ');
}

/* ---------- 展示偏好：显式接收者与最近活动（§9.6） ---------- */

export const ACTIVITY_KEY = 'wsl-session-activity-v1';
/** 每个空间最多记住的会话数；超出时丢弃最早的。 */
export const ACTIVITY_LIMIT = 50;
/** 同一会话的活动在这个间隔内只记一次（输入时不逐键改写偏好）。 */
const ACTIVITY_INTERVAL = 1000;

type Activity = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** 读取本机保存的最近活动；格式不对时整体丢弃或逐项过滤，不抛错（偏好可以丢失，界面照常可用）。 */
export function restoreActivity(raw: string | null): Activity {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Record<string, Record<string, number>> = {};
  for (const [workspaceId, sessions] of Object.entries(parsed)) {
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) continue;
    const valid = Object.entries(sessions).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
    );
    if (valid.length) result[workspaceId] = Object.fromEntries(valid);
  }
  return result;
}

let saveFailed = false;
function saveActivity(activity: Activity) {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
    saveFailed = false;
  } catch (error) {
    // 内存中的记录仍然生效，只是重启后不保留；同一原因只登记一次，不随每次操作重复提示。
    if (!saveFailed) reportError('保存最近使用的会话', error);
    saveFailed = true;
  }
}

/** 显式接收者按 `[空间, 网页]` 记录（只在本次运行中有效）；最近活动按空间记录并保存在本机。 */
export const receiverStore = createStore<{ explicit: Readonly<Record<string, string>>; activity: Activity }>({
  explicit: {},
  activity: {},
});
const pageKey = (workspaceId: string, resourceId: string) => JSON.stringify([workspaceId, resourceId]);
const EMPTY: Readonly<Record<string, number>> = {};

export const receiverActions = {
  /** 启动时读取本机保存的最近活动（App 初始化时调用一次）；读取失败时登记错误并按无记录处理。 */
  load() {
    try {
      const activity = restoreActivity(localStorage.getItem(ACTIVITY_KEY));
      receiverStore.set((state) => ({ ...state, activity }));
    } catch (error) {
      reportError('读取最近使用的会话', error);
    }
  },
  /** 接收者按钮中的显式选择：只影响之后的采集，已发起的请求仍归原会话。 */
  choose(workspaceId: string, resourceId: string, sessionId: string) {
    receiverStore.set((state) => ({ ...state, explicit: { ...state.explicit, [pageKey(workspaceId, resourceId)]: sessionId } }));
  },
  explicit(workspaceId: string, resourceId: string): string | null {
    return receiverStore.get().explicit[pageKey(workspaceId, resourceId)] ?? null;
  },
  /** 记录会话的最近活动（在会话中操作、发送、收到采集结果）。 */
  record(workspaceId: string, sessionId: string, now = Date.now()) {
    const current = receiverStore.get().activity[workspaceId] ?? EMPTY;
    const last = current[sessionId];
    if (last !== undefined && now >= last && now - last < ACTIVITY_INTERVAL) return;
    const entries = Object.entries({ ...current, [sessionId]: now })
      .sort((a, b) => b[1] - a[1])
      .slice(0, ACTIVITY_LIMIT);
    const activity = { ...receiverStore.get().activity, [workspaceId]: Object.fromEntries(entries) };
    receiverStore.set((state) => ({ ...state, activity }));
    saveActivity(activity);
  },
};

/** 组件读取某网页的显式接收者与所在空间的最近活动（引用稳定，便于 useStore）。 */
export function useReceiverPreferences(workspaceId: string, resourceId: string) {
  const explicit = useStore(receiverStore, (state) => state.explicit[pageKey(workspaceId, resourceId)] ?? null);
  const activity = useStore(receiverStore, (state) => state.activity[workspaceId] ?? EMPTY);
  return { explicit, activity };
}
