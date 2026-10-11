import { useMemo } from 'react';
import type {
  ChatStatus,
  ExecutionStatus,
  SetupSnapshot,
  StatusDomain,
  StatusFact,
  StatusKind,
  StatusRaw,
  StatusScope,
  WorkbenchSnapshot,
} from '@wsl/protocol';
import { projectFacts } from '../../../shared/status';
import { createStore, useStore } from '../lib/store';
import { chatStore } from './chat';
import { environmentStore } from './execution';
import { setupStore } from './setup';
import { workspaceStore } from './workspace';

/*
 * 第 ② 层：展示投影（status-interface.md §5–§6）。
 * presentStatus 是纯函数：输入 = 业务事实 + 展示状态，输出 = 带通道与可见性的 StatusView；不写回 Main，不持久化业务状态。
 * 展示状态（statusPresentationStore）是 Renderer 自有的 UI 状态，组件只能经 statusPresentationActions 写入。
 *
 * 取舍说明：
 * - workspaceError 不迁移所有权：仍由 workspaceStore.error 单点写入，这里只把它作为 presentToasts 的输入读取。
 * - occlusion 不镜像进 PresentationState：需要遮挡的组件（StatusSlot 的「另有 N 项」菜单）直接使用 occlusion.open / close。
 */

/* ---------- 展示状态 ---------- */

export interface UiError {
  id: number;
  context: string;
  message: string;
}

export interface HistorySelection {
  taskVersionId?: string;
  runId?: string;
}

export interface Hint {
  /** `ui:<resourceId|sessionId>:<name>` */
  key: string;
  scope: StatusScope;
  label: string;
  source: 'capture-guidance' | 'bookmark' | 'snapshot' | 'reference' | 'first-use';
  until: 'ack' | 'navigation';
}

export interface TerminalGap {
  instanceId: string | null;
  sessionId: string | null;
}

/** 终端实例身份，与 shared/status/facts.ts 中终端事实的 instanceToken 同一规则。 */
export const terminalToken = (instanceId: string | null | undefined, sessionId: string | null | undefined) =>
  `${instanceId ?? 'none'}:${sessionId ?? 'none'}`;

const GAP_ACK_KEY = (resourceId: string) => `ui:${resourceId}:output-gap`;

export interface PresentationState {
  selections: Readonly<Record<string, HistorySelection>>;
  /** 事实 key → 确认时的 instanceToken。 */
  acks: Readonly<Record<string, string>>;
  hints: readonly Hint[];
  terminalGaps: Readonly<Record<string, TerminalGap>>;
  uiErrors: readonly UiError[];
}

export const EMPTY_PRESENTATION: PresentationState = { selections: {}, acks: {}, hints: [], terminalGaps: {}, uiErrors: [] };

export const statusPresentationStore = createStore<PresentationState>(EMPTY_PRESENTATION);

export const TOAST_LIMIT = 5;
export const GAP_LABEL = '未读输出超出保留窗口；已从当前窗口重建显示';
export const HISTORY_UNAVAILABLE_LABEL = '指定历史记录已不可用，请重新从任务历史定位。';
export const HISTORY_CONTEXT_LABEL = '现场适用性：历史采集（不表示当前现场）';

/* ---------- 键与范围 ---------- */

export function scopeKey(scope: StatusScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace:${scope.workspaceId}`;
    case 'resource':
      return `resource:${scope.workspaceId}:${scope.resourceId}`;
    case 'session':
      return `session:${scope.workspaceId}:${scope.sessionId}`;
  }
}

export const sameScope = (a: StatusScope, b: StatusScope) => scopeKey(a) === scopeKey(b);

/** `<domain>:<entityId>:<facet>` → entityId（entityId 之后只有不含冒号的 facet）。 */
function entityOf(fact: { key: string; domain: string }): string {
  return fact.key.slice(fact.domain.length + 1, fact.key.lastIndexOf(':'));
}

/* ---------- 具名动作（组件唯一的写入口） ---------- */

let nextErrorId = 1;

type AckTarget = Pick<StatusFact, 'key' | 'kind' | 'scope' | 'instanceToken'>;

const sameSelection = (a: HistorySelection, b: HistorySelection) => a.runId === b.runId && a.taskVersionId === b.taskVersionId;

export const statusPresentationActions = {
  /** 会话的版本 / 运行选择；null 清除。 */
  selectHistory(sessionId: string, selection: HistorySelection | null) {
    statusPresentationStore.set((state) => {
      const current = state.selections[sessionId];
      if (!selection) {
        if (!current) return state;
        const { [sessionId]: _removed, ...rest } = state.selections;
        return { ...state, selections: rest };
      }
      if (current && sameSelection(current, selection)) return state;
      return { ...state, selections: { ...state.selections, [sessionId]: { ...selection } } };
    });
  },

  /**
   * 用户与某窗格交互后确认其中的 confirmation 事实：acks[key] = instanceToken。
   * 同一范围内 until='ack' 的 hint 同时清除（§6.2）。unresolved / progress 等其他 kind 从不被确认。
   */
  ackFacts(scope: StatusScope, facts: readonly AckTarget[]) {
    statusPresentationStore.set((state) => {
      const hintKeys = new Set(state.hints.map((hint) => hint.key));
      const acks = { ...state.acks };
      let changed = false;
      for (const fact of facts) {
        if (fact.kind !== 'confirmation' || hintKeys.has(fact.key) || !sameScope(fact.scope, scope)) continue;
        if (acks[fact.key] === fact.instanceToken) continue;
        acks[fact.key] = fact.instanceToken;
        changed = true;
      }
      const hints = state.hints.filter((hint) => !(hint.until === 'ack' && sameScope(hint.scope, scope)));
      if (hints.length !== state.hints.length) changed = true;
      return changed ? { ...state, acks, hints } : state;
    });
  },

  /** 「知道了」：hint 直接移除，confirmation 记录确认。 */
  acknowledge(scope: StatusScope, view: AckTarget) {
    if (statusPresentationStore.get().hints.some((h) => h.key === view.key)) statusPresentationActions.dismissHint(view.key);
    else statusPresentationActions.ackFacts(scope, [view]);
  },

  /** 登记一次性提示；同 key 覆盖并视为最新。 */
  hint(hint: Hint) {
    statusPresentationStore.set((state) => ({ ...state, hints: [...state.hints.filter((h) => h.key !== hint.key), { ...hint }] }));
  },

  dismissHint(key: string) {
    statusPresentationStore.set((state) =>
      state.hints.some((h) => h.key === key) ? { ...state, hints: state.hints.filter((h) => h.key !== key) } : state,
    );
  },

  /** 切换到 workspaceId 后，清除不属于该空间的 until='navigation' hint（全局 hint 也属于「不属于新空间」）。 */
  clearNavigationHints(workspaceId: string) {
    statusPresentationStore.set((state) => {
      const hints = state.hints.filter(
        (h) => h.until !== 'navigation' || (h.scope.kind !== 'global' && h.scope.workspaceId === workspaceId),
      );
      return hints.length === state.hints.length ? state : { ...state, hints };
    });
  },

  /** 登记一次输出缺口。每次新缺口都是新的提示：同一 PTY 会话里再次缺口时，清除此前对它的确认。 */
  setTerminalGap(resourceId: string, gap: TerminalGap) {
    statusPresentationStore.set((state) => {
      const current = state.terminalGaps[resourceId];
      const ackKey = GAP_ACK_KEY(resourceId);
      const unchanged = current && current.instanceId === gap.instanceId && current.sessionId === gap.sessionId;
      if (unchanged && !(ackKey in state.acks)) return state;
      const { [ackKey]: _ack, ...acks } = state.acks;
      return { ...state, acks, terminalGaps: unchanged ? state.terminalGaps : { ...state.terminalGaps, [resourceId]: { ...gap } } };
    });
  },

  clearTerminalGap(resourceId: string) {
    statusPresentationStore.set((state) => {
      const ackKey = GAP_ACK_KEY(resourceId);
      if (!state.terminalGaps[resourceId] && !(ackKey in state.acks)) return state;
      const { [resourceId]: _removed, ...terminalGaps } = state.terminalGaps;
      const { [ackKey]: _ack, ...acks } = state.acks;
      return { ...state, acks, terminalGaps };
    });
  },

  /** 界面操作失败时登记（最多保留 5 条，与旧 errorStore 一致）。 */
  pushUiError(context: string, message: string): number {
    const id = nextErrorId++;
    statusPresentationStore.set((state) => ({
      ...state,
      uiErrors: [...state.uiErrors.slice(-(TOAST_LIMIT - 1)), { id, context, message }],
    }));
    return id;
  },

  dismissUiError(id: number) {
    statusPresentationStore.set((state) =>
      state.uiErrors.some((e) => e.id === id) ? { ...state, uiErrors: state.uiErrors.filter((e) => e.id !== id) } : state,
    );
  },

  /**
   * 按快照清理展示状态：会话消失删除 selections；终端实例或 PTY 会话变化（或资源消失）删除 terminalGaps；
   * 实体已不在快照中的 acks（global 域保留）与 scope 已消失的 hints 一并删除。没有变化时保持原引用。
   */
  pruneForSnapshot(snapshot: WorkbenchSnapshot) {
    statusPresentationStore.set((state) => {
      const live = liveEntities(snapshot);
      const selections = filterRecord(state.selections, (sessionId) => live.sessions.has(sessionId));
      const terminalGaps = filterRecord(state.terminalGaps, (resourceId, gap) => {
        const resource = live.resources.get(resourceId);
        return (
          !!resource && terminalToken(resource.instanceId, resource.terminal?.sessionId) === terminalToken(gap.instanceId, gap.sessionId)
        );
      });
      const acks = filterRecord(state.acks, (key) => ackEntityExists(key, live));
      const hints = state.hints.filter((hint) => scopeExists(hint.scope, live));
      if (
        selections === state.selections &&
        terminalGaps === state.terminalGaps &&
        acks === state.acks &&
        hints.length === state.hints.length
      )
        return state;
      return { ...state, selections, terminalGaps, acks, hints: hints.length === state.hints.length ? state.hints : hints };
    });
  },
};

interface LiveEntities {
  workspaces: Set<string>;
  sessions: Set<string>;
  resources: Map<string, WorkbenchSnapshot['workspaces'][number]['resources'][number]>;
  /** workspaceId → 该空间内的资源 id。 */
  resourcesByWorkspace: Map<string, Set<string>>;
  runs: Set<string>;
  observations: Set<string>;
}

function liveEntities(snapshot: WorkbenchSnapshot): LiveEntities {
  const live: LiveEntities = {
    workspaces: new Set(),
    sessions: new Set(),
    resources: new Map(),
    resourcesByWorkspace: new Map(),
    runs: new Set(),
    observations: new Set(),
  };
  for (const workspace of snapshot.workspaces) {
    live.workspaces.add(workspace.workspaceId);
    live.resourcesByWorkspace.set(workspace.workspaceId, new Set(workspace.resources.map((r) => r.resourceId)));
    for (const resource of workspace.resources) live.resources.set(resource.resourceId, resource);
    for (const session of workspace.sessions) {
      live.sessions.add(session.sessionId);
      for (const record of session.observations) live.observations.add(record.request.requestId);
    }
    for (const run of workspace.runs) live.runs.add(run.runId);
    for (const record of workspace.observations) live.observations.add(record.request.requestId);
  }
  return live;
}

/** 过滤记录；全部保留时返回原对象，便于调用方判断是否变化。 */
function filterRecord<V>(record: Readonly<Record<string, V>>, keep: (key: string, value: V) => boolean): Readonly<Record<string, V>> {
  const entries = Object.entries(record);
  const kept = entries.filter(([key, value]) => keep(key, value));
  return kept.length === entries.length ? record : Object.fromEntries(kept);
}

/** ack 的 key 为 `<domain>:<entityId>:<facet>`；实体已不在快照中则作废，global 域（chat / setup / execution / storage）保留。 */
function ackEntityExists(key: string, live: LiveEntities): boolean {
  const domain = key.slice(0, key.indexOf(':'));
  const entity = key.slice(domain.length + 1, key.lastIndexOf(':'));
  switch (domain) {
    case 'web':
    case 'terminal':
    case 'file':
      return live.resources.has(entity);
    case 'app':
      return live.workspaces.has(entity);
    case 'run':
    case 'validation':
    case 'review':
      return live.runs.has(entity);
    case 'context':
      return live.sessions.has(entity);
    case 'observation':
      return live.observations.has(entity);
    case 'ui':
      return live.resources.has(entity) || live.sessions.has(entity);
    default:
      return true;
  }
}

function scopeExists(scope: StatusScope, live: LiveEntities): boolean {
  switch (scope.kind) {
    case 'global':
      return true;
    case 'workspace':
      return live.workspaces.has(scope.workspaceId);
    case 'resource':
      return live.resourcesByWorkspace.get(scope.workspaceId)?.has(scope.resourceId) ?? false;
    case 'session':
      return live.sessions.has(scope.sessionId);
  }
}

/** 把工作区 store 的变化同步为展示状态清理：切换空间清 navigation hint，快照变化时按事实清理。返回取消订阅函数。 */
export function startStatusPresentationSync(): () => void {
  let selectedId: string | null = null;
  let pruned: WorkbenchSnapshot | null = null;
  const apply = () => {
    const { selectedId: next, snapshot } = workspaceStore.get();
    if (next !== selectedId) {
      selectedId = next;
      if (next) statusPresentationActions.clearNavigationHints(next);
    }
    // 快照引用未变（只是 selectedId / error 变化）时不必再清理。
    if (snapshot && snapshot !== pruned) {
      pruned = snapshot;
      statusPresentationActions.pruneForSnapshot(snapshot);
    }
  };
  apply();
  return workspaceStore.subscribe(apply);
}

/* ---------- 展示投影 ---------- */

export type StatusChannel = 'persistent' | 'problem' | 'notice' | 'ambient' | 'toast' | 'banner' | 'settings';

/**
 * 事实 + 通道 + 可见性。展示层合成的条目（hint、终端输出缺口、历史记录不可用）使用 domain: 'ui'。
 * visible:false 有两种原因：被折叠 / 排队（problem 的「另有 N 项」、同时只显示一条的 notice、已确认的 confirmation），
 * 或不是该会话 / 范围的当前项（historical: true，不计入「另有 N 项」）；persistent 类不受当前项限定。
 */
export interface StatusView {
  key: string;
  domain: StatusDomain | 'ui';
  facet: string;
  scope: StatusScope;
  phase: StatusFact['phase'];
  kind: StatusKind;
  priority: number;
  label: string;
  detail?: string;
  action?: StatusFact['action'];
  instanceToken: string;
  raw?: StatusRaw;
  channel: StatusChannel;
  visible: boolean;
  historical?: true;
}

export interface PresentInput {
  /** 用于核对所选任务版本是否仍存在；缺省时不做版本存在性检查。 */
  snapshot?: WorkbenchSnapshot | null;
}

const KIND_RANK: Record<StatusKind, number> = {
  control: 0,
  unresolved: 1,
  progress: 2,
  problem: 3,
  confirmation: 4,
  steady: 5,
  capability: 6,
};

const compareViews = (a: StatusView, b: StatusView) =>
  KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.priority - a.priority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function channelOf(fact: Pick<StatusFact, 'kind' | 'scope' | 'domain'>): StatusChannel {
  switch (fact.kind) {
    case 'control':
    case 'unresolved':
    case 'progress':
      return 'persistent';
    case 'problem':
      return fact.domain === 'storage' ? 'banner' : fact.scope.kind === 'global' ? 'toast' : 'problem';
    case 'confirmation':
      return 'notice';
    case 'steady':
      return 'ambient';
    case 'capability':
      return 'settings';
  }
}

const isRunDomain = (fact: StatusFact) => fact.domain === 'run' || fact.domain === 'validation' || fact.domain === 'review';

function versionIdsOf(snapshot: WorkbenchSnapshot | null | undefined, scope: StatusScope): ReadonlySet<string> | null {
  if (!snapshot || scope.kind !== 'session') return null;
  const session = snapshot.workspaces
    .find((w) => w.workspaceId === scope.workspaceId)
    ?.sessions.find((s) => s.sessionId === scope.sessionId);
  return session ? new Set(session.taskVersions.map((v) => v.taskVersionId)) : null;
}

/** 与 workspace/presentation.ts 的 sessionSelection 同一判定，输入换成事实。 */
function resolveSelection(
  selection: HistorySelection,
  own: readonly StatusFact[],
  versions: ReadonlySet<string> | null,
  runVersions: ReadonlyMap<string, string> | null,
) {
  // raw 可能降级为 { truncated: true }，所以优先按快照里的 runId → taskVersionId 取；没有快照时才退回 raw。
  const taskVersionOf = (fact: StatusFact) =>
    runVersions?.get(entityOf(fact)) ?? (fact.domain === 'run' ? fact.raw.taskVersionId : undefined);
  const run = selection.runId
    ? own.find((fact) => entityOf(fact) === selection.runId)
    : selection.taskVersionId
      ? own.filter((fact) => taskVersionOf(fact) === selection.taskVersionId).at(-1)
      : own.at(-1);
  const selectedVersion = selection.runId ? (run ? taskVersionOf(run) : undefined) : selection.taskVersionId;
  const versionExists = !versions ? true : selectedVersion ? versions.has(selectedVersion) : versions.size > 0;
  const unavailable = (!!selection.runId && !run) || (!!selection.taskVersionId && !versionExists);
  return { run, unavailable };
}

/**
 * 每个 scope 内 startedAt 最晚（并列取数组中靠后）的观察记录 requestId。
 * scope 规则与 shared/status/facts.ts 的 observationFacts 一致：会话（所属会话优先于 request.sessionId）> 目标资源 > 空间；
 * 记录来源与去重同样是 workspace.observations 在前、session.observations 在后，按 requestId 去重。
 */
function latestObservationIds(snapshot: WorkbenchSnapshot): Map<string, string> {
  const latest = new Map<string, { requestId: string; at: number }>();
  for (const workspace of snapshot.workspaces) {
    const seen = new Set<string>();
    const records: Array<[string | null, (typeof workspace.observations)[number]]> = [
      ...workspace.observations.map((record): [string | null, (typeof workspace.observations)[number]] => [null, record]),
      ...workspace.sessions.flatMap((session) =>
        session.observations.map((record): [string | null, (typeof workspace.observations)[number]] => [session.sessionId, record]),
      ),
    ];
    for (const [owner, record] of records) {
      const request = record.request;
      if (seen.has(request.requestId)) continue;
      seen.add(request.requestId);
      const sessionId = owner ?? request.sessionId;
      const scope: StatusScope = sessionId
        ? { kind: 'session', workspaceId: workspace.workspaceId, sessionId }
        : request.target
          ? { kind: 'resource', workspaceId: workspace.workspaceId, resourceId: request.target.resourceId }
          : { kind: 'workspace', workspaceId: workspace.workspaceId };
      const key = scopeKey(scope);
      const parsed = Date.parse(record.startedAt);
      const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
      const current = latest.get(key);
      if (!current || at >= current.at) latest.set(key, { requestId: request.requestId, at });
    }
  }
  return new Map([...latest].map(([key, value]) => [key, value.requestId]));
}

/**
 * 展示投影。通道规则见 status-interface.md §5：
 * - control / unresolved / progress → persistent：全部可见，不折叠，不因交互降级；
 * - problem → problem：每个 scope 只有 1 条 visible，其余 visible:false 进「另有 N 项」；无窗格归属的进 toast，storage 进 banner；
 * - confirmation 与 hint → notice：每个 scope 同时只显示 1 条；confirmation 已被同一 instanceToken 确认则不显示；
 * - steady → ambient；capability → settings。
 * 会话只呈现当前 run（有历史选择时为所选 run，否则最新一条）的 run / validation / review，观察只呈现每个 scope 最新一条。
 */
export function presentStatus(facts: readonly StatusFact[], state: PresentationState, input: PresentInput = {}): StatusView[] {
  // 每个会话的当前 run。
  const ownRuns = new Map<string, StatusFact[]>();
  for (const fact of facts) {
    if (fact.domain !== 'run' || fact.facet !== 'state' || fact.scope.kind !== 'session') continue;
    const list = ownRuns.get(fact.scope.sessionId) ?? [];
    list.push(fact);
    ownRuns.set(fact.scope.sessionId, list);
  }
  const sessionScopes = new Map<string, StatusScope>();
  for (const fact of facts)
    if (fact.scope.kind === 'session' && !sessionScopes.has(fact.scope.sessionId)) sessionScopes.set(fact.scope.sessionId, fact.scope);

  const runVersions = input.snapshot
    ? new Map(input.snapshot.workspaces.flatMap((w) => w.runs.map((r) => [r.runId, r.taskVersionId] as const)))
    : null;
  const currentRun = new Map<string, string | null>();
  const unavailable: string[] = [];
  for (const [sessionId, scope] of sessionScopes) {
    const own = ownRuns.get(sessionId) ?? [];
    const selection = state.selections[sessionId];
    if (selection) {
      const resolved = resolveSelection(selection, own, versionIdsOf(input.snapshot, scope), runVersions);
      currentRun.set(sessionId, resolved.run ? entityOf(resolved.run) : null);
      if (resolved.unavailable) unavailable.push(sessionId);
    } else {
      const last = own.at(-1);
      currentRun.set(sessionId, last ? entityOf(last) : null);
    }
  }

  // 每个 scope 最新的观察：有快照时按记录的 startedAt 判定（含 cancelled / completed，它们可能不产出事实，但仍应压住旧的失败）；
  // 没有快照时退回事实顺序（后者更新）。
  const latestObservation = input.snapshot ? latestObservationIds(input.snapshot) : new Map<string, string>();
  if (!input.snapshot)
    for (const fact of facts) if (fact.domain === 'observation') latestObservation.set(scopeKey(fact.scope), entityOf(fact));

  const views: StatusView[] = [];
  for (const fact of facts) {
    const base: StatusView = { ...fact, channel: channelOf(fact), visible: true };
    // 当前项限定只作用于 steady / problem / confirmation；persistent 类（control / unresolved / progress）不论属于哪个 run 都必须可见（§5）。
    const limited = base.channel !== 'persistent';
    if (limited && isRunDomain(fact) && fact.scope.kind === 'session' && currentRun.get(fact.scope.sessionId) !== entityOf(fact)) {
      views.push({ ...base, visible: false, historical: true });
      continue;
    }
    if (limited && fact.domain === 'observation' && latestObservation.get(scopeKey(fact.scope)) !== entityOf(fact)) {
      views.push({ ...base, visible: false, historical: true });
      continue;
    }
    if (
      fact.domain === 'context' &&
      fact.facet === 'applicability' &&
      fact.scope.kind === 'session' &&
      state.selections[fact.scope.sessionId]
    ) {
      const { action: _action, detail: _detail, ...rest } = base;
      views.push({ ...rest, phase: 'idle', kind: 'steady', label: HISTORY_CONTEXT_LABEL, channel: 'ambient' });
      continue;
    }
    views.push(base);
  }

  for (const sessionId of unavailable) {
    const scope = sessionScopes.get(sessionId);
    if (!scope) continue;
    views.push({
      key: `ui:${sessionId}:history-unavailable`,
      domain: 'ui',
      facet: 'history-unavailable',
      scope,
      phase: 'failed',
      kind: 'problem',
      priority: 65,
      label: HISTORY_UNAVAILABLE_LABEL,
      instanceToken: sessionId,
      channel: 'problem',
      visible: true,
    });
  }

  // 终端输出缺口：仅当实例仍是记录缺口时的那一个。
  for (const [resourceId, gap] of Object.entries(state.terminalGaps)) {
    const terminal = facts.find((fact) => fact.key === `terminal:${resourceId}:state`);
    const token = terminalToken(gap.instanceId, gap.sessionId);
    if (!terminal || terminal.instanceToken !== token) continue;
    views.push({
      key: `ui:${resourceId}:output-gap`,
      domain: 'ui',
      facet: 'output-gap',
      scope: terminal.scope,
      phase: 'degraded',
      kind: 'confirmation',
      priority: 90,
      label: GAP_LABEL,
      instanceToken: token,
      channel: 'notice',
      visible: true,
    });
  }

  // 一次性提示：后登记的优先于较早的，且优先于 confirmation 事实。
  state.hints.forEach((hint, index) => {
    views.push({
      key: hint.key,
      domain: 'ui',
      facet: hint.source,
      scope: hint.scope,
      phase: 'idle',
      kind: 'confirmation',
      priority: 100 + index,
      label: hint.label,
      instanceToken: hint.key,
      channel: 'notice',
      visible: true,
    });
  });

  // 已确认的 confirmation：同一 instanceToken 不再显示；token 变化后自然重现。hint 以移除表达已读，不走 acks。
  const hintKeys = new Set(state.hints.map((hint) => hint.key));
  for (const view of views) {
    if (view.channel === 'notice' && !hintKeys.has(view.key) && state.acks[view.key] === view.instanceToken) view.visible = false;
  }

  views.sort(compareViews);

  // problem / notice：每个 scope 只让优先级最高的一条可见。views 已排序，所以第一条见到的即最高。
  for (const channel of ['problem', 'notice'] as const) {
    const taken = new Set<string>();
    for (const view of views) {
      if (view.channel !== channel || !view.visible) continue;
      const key = scopeKey(view.scope);
      if (taken.has(key)) view.visible = false;
      else taken.add(key);
    }
  }
  return views;
}

/* ---------- Toast 队列 ---------- */

export type ToastItem =
  | { kind: 'ui-error'; id: string; error: UiError }
  | { kind: 'workspace-error'; id: string; message: string }
  | { kind: 'status'; id: string; view: StatusView };

export interface ToastInput {
  /** workspaceStore.error 的当前值；所有权仍在 workspaceStore。 */
  workspaceError?: string | null;
}

/** 合并后的 Toast 队列，最多 TOAST_LIMIT 条：先是界面错误与工作区错误（超出时丢弃最早的），余位给无窗格归属的 problem。失败类不自动消失。 */
export function presentToasts(views: readonly StatusView[], state: PresentationState, input: ToastInput = {}): ToastItem[] {
  const errors: ToastItem[] = state.uiErrors.map((error) => ({ kind: 'ui-error', id: `ui-error:${error.id}`, error }));
  if (input.workspaceError) errors.push({ kind: 'workspace-error', id: 'workspace-error', message: input.workspaceError });
  const kept = errors.slice(-TOAST_LIMIT);
  const status: ToastItem[] = views
    .filter((view) => view.channel === 'toast' && view.visible)
    .slice(0, TOAST_LIMIT - kept.length)
    .map((view) => ({ kind: 'status', id: `status:${view.key}`, view }));
  return [...kept, ...status];
}

/* ---------- Hook ---------- */

export interface StatusViewResult {
  persistent: StatusView[];
  problem: StatusView | null;
  more: StatusView[];
  notice: StatusView | null;
  ambient: StatusView[];
}

const EMPTY_VIEWS: StatusView[] = [];

/** 把某个 scope 的视图分入三条通道。输入已按 compareViews 排序。 */
export function groupForScope(views: readonly StatusView[]): StatusViewResult {
  const problems = views.filter((view) => view.channel === 'problem');
  return {
    persistent: views.filter((view) => view.channel === 'persistent' && view.visible),
    problem: problems.find((view) => view.visible) ?? null,
    more: problems.filter((view) => !view.visible && !view.historical),
    notice: views.find((view) => view.channel === 'notice' && view.visible) ?? null,
    ambient: views.filter((view) => view.channel === 'ambient' && view.visible),
  };
}

export interface StatusDeps {
  snapshot: WorkbenchSnapshot | null;
  chat: ChatStatus | null;
  setup: SetupSnapshot | null;
  execution: ExecutionStatus | null;
  presentation: PresentationState;
  workspaceError: string | null;
}

export interface DerivedStatus {
  facts: StatusFact[];
  views: StatusView[];
  byScope: ReadonlyMap<string, StatusView[]>;
  toasts: ToastItem[];
  banner: StatusView | null;
}

export function deriveStatus(deps: StatusDeps): DerivedStatus {
  const facts = projectFacts({ snapshot: deps.snapshot, chat: deps.chat, setup: deps.setup, execution: deps.execution });
  const views = presentStatus(facts, deps.presentation, { snapshot: deps.snapshot });
  const byScope = new Map<string, StatusView[]>();
  for (const view of views) {
    const key = scopeKey(view.scope);
    const list = byScope.get(key);
    if (list) list.push(view);
    else byScope.set(key, [view]);
  }
  return {
    facts,
    views,
    byScope,
    toasts: presentToasts(views, deps.presentation, { workspaceError: deps.workspaceError }),
    banner: views.find((view) => view.channel === 'banner') ?? null,
  };
}

/** 多个组件共用同一份计算：依赖引用都没变时直接复用上一次结果。 */
let memo: { deps: StatusDeps; value: DerivedStatus } | null = null;
export function derivedStatus(deps: StatusDeps): DerivedStatus {
  if (memo && (Object.keys(deps) as Array<keyof StatusDeps>).every((key) => memo!.deps[key] === deps[key])) return memo.value;
  const value = deriveStatus(deps);
  memo = { deps, value };
  return value;
}

function useDerivedStatus(): DerivedStatus {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  const workspaceError = useStore(workspaceStore, (s) => s.error);
  const chat = useStore(chatStore, (s) => s.status);
  const setup = useStore(setupStore, (s) => s.snapshot);
  const execution = useStore(environmentStore, (s) => s.execution);
  const presentation = useStore(statusPresentationStore, (s) => s);
  return derivedStatus({ snapshot, chat, setup, execution, presentation, workspaceError });
}

/** 某个窗格 / 会话 / 空间的状态：常驻通道、问题通道（一条 + more）、提示通道、环境级。 */
export function useStatusView(scope: StatusScope): StatusViewResult {
  const { byScope } = useDerivedStatus();
  const key = scopeKey(scope);
  const views = byScope.get(key) ?? EMPTY_VIEWS;
  return useMemo(() => groupForScope(views), [views]);
}

export function useToastQueue(): ToastItem[] {
  return useDerivedStatus().toasts;
}

/** 持久化失败的底部横幅事实；没有失败时为 null。 */
export function useStorageBanner(): StatusView | null {
  return useDerivedStatus().banner;
}

/** 当前 scope 内所有可确认的 confirmation 视图（供窗格交互时调用 ackFacts）。 */
export function ackScope(scope: StatusScope): void {
  const { views } = derivedStatus({
    snapshot: workspaceStore.get().snapshot,
    chat: chatStore.get().status,
    setup: setupStore.get().snapshot,
    execution: environmentStore.get().execution,
    presentation: statusPresentationStore.get(),
    workspaceError: workspaceStore.get().error,
  });
  const visible = views.filter((view) => view.channel === 'notice' && view.visible && sameScope(view.scope, scope));
  if (visible.length === 0) return;
  statusPresentationActions.ackFacts(scope, visible);
}
