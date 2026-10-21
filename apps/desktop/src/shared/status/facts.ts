import {
  StatusRawSchemas,
  type AgentControlState,
  type CdpState,
  type ChatStatus,
  type EnvironmentDescription,
  type ExecutionStatus,
  type FileInvalidationHint,
  type ManagedApp,
  type Observation,
  type ObservationError,
  type ObservationRecord,
  type SetupSnapshot,
  type StatusAction,
  type StatusActionId,
  type StatusDomain,
  type StatusFact,
  type StatusKind,
  type StatusPhase,
  type StatusRawByDomain,
  type StatusScope,
  type TerminalSnapshot,
  type WorkbenchResource,
  type WorkbenchRun,
  type WorkbenchSession,
  type WorkbenchSnapshot,
  type WorkspaceSnapshot,
} from '@wsl/protocol';
import { redactSecrets, redactUrl, truncateText, utf8Length } from './redact';

/*
 * 第 ① 层：业务事实投影（status-interface.md §2–§4）。
 * 纯函数；只读 Main 已发布的快照，不含任何界面状态，也不写回。Main 与 Renderer 共用同一实现。
 *
 * priority 约定：数值越大越靠前，且只在同一通道（同一 kind 组）内比较。
 *   control 100–110，unresolved 80–95，progress 50–75，problem 10–90，confirmation 10–20，steady/capability ≤ 10。
 *   problem 内：全局不可用 / 持久化失败最高；运行失败 > 检查 / 适用性 > 资源级问题；
 *   网页内严格按设计 load-error > pick-error > cdp > blocked-nav > unavailable。
 */

export interface FactInput {
  snapshot: WorkbenchSnapshot | null;
  chat: ChatStatus | null;
  setup: SetupSnapshot | null;
  execution: ExecutionStatus | null;
}

export const LABEL_LIMIT = 120;
export const DETAIL_LIMIT = 300;
/** 单条 raw 序列化后的字节上限（§8.5）。 */
export const RAW_LIMIT_BYTES = 2048;

interface ActionSpec {
  id: StatusActionId;
  label: string;
}
interface Mapping {
  phase: StatusPhase;
  kind: StatusKind;
  priority: number;
  label: string;
  action?: ActionSpec;
}

/* ---------- 构造辅助 ---------- */

interface Entity<D extends StatusDomain> {
  domain: D;
  entityId: string;
  scope: StatusScope;
  instanceToken: string;
}
interface FactSpec<D extends StatusDomain> {
  phase: StatusPhase;
  kind: StatusKind;
  priority: number;
  label: string;
  detail?: string | null;
  action?: ActionSpec | StatusAction;
  raw: StatusRawByDomain[D];
}

const compact = (value: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

const rawBytes = (raw: object) => utf8Length(JSON.stringify(raw));

/**
 * 超过 2 KiB 时逐级缩短字符串字段，最后丢弃字符串字段，并标 truncated: true。
 * 注意：max = 16 一档可能截断枚举字符串（使其不再通过 schema），但白名单字段很少，
 * 最多约十个短字符串，实际只有 id 类字段会长到触发截断，该档目前不可达；万一到达，下面的 safeParse 会降级为 { truncated: true }。
 */
function capRaw(raw: Record<string, unknown>): Record<string, unknown> {
  if (rawBytes(raw) <= RAW_LIMIT_BYTES) return raw;
  for (const max of [256, 64, 16, 0]) {
    const entries = Object.entries(raw).flatMap(([key, value]): Array<[string, unknown]> => {
      if (typeof value !== 'string') return [[key, value]];
      return max === 0 ? [] : [[key, truncateText(value, max)]];
    });
    const next = { ...Object.fromEntries(entries), truncated: true };
    if (rawBytes(next) <= RAW_LIMIT_BYTES) return next;
  }
  return { truncated: true };
}

/** 白名单校验：schema 为 strict，多余字段或非法取值都不会进入事实；校验失败时降级为 { truncated: true }，不抛异常。 */
function whitelistRaw<D extends StatusDomain>(domain: D, raw: StatusRawByDomain[D]): StatusRawByDomain[D] {
  const schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } } = StatusRawSchemas[domain];
  const parsed = schema.safeParse(capRaw(compact(raw)));
  if (parsed.success) return parsed.data as StatusRawByDomain[D];
  return StatusRawSchemas[domain].parse({ truncated: true }) as StatusRawByDomain[D];
}

function build<D extends StatusDomain>(entity: Entity<D>, facet: string, spec: FactSpec<D>): StatusFact {
  // 先去凭据再截断：否则凭据被截断后不再匹配模式，残片会漏过。
  const detail = spec.detail ? truncateText(redactSecrets(spec.detail), DETAIL_LIMIT) : undefined;
  return {
    key: `${entity.domain}:${entity.entityId}:${facet}`,
    domain: entity.domain,
    facet,
    scope: entity.scope,
    phase: spec.phase,
    kind: spec.kind,
    priority: spec.priority,
    label: truncateText(redactSecrets(spec.label), LABEL_LIMIT),
    ...(detail ? { detail } : {}),
    ...(spec.action ? { action: { ...spec.action } } : {}),
    instanceToken: entity.instanceToken,
    raw: whitelistRaw(entity.domain, spec.raw),
  } as StatusFact;
}

/** 从映射表得到 phase / kind / priority / label / action，可覆盖其中的 label 与 action。 */
function fromMapping<D extends StatusDomain>(
  mapping: Mapping,
  extra: { raw: StatusRawByDomain[D]; detail?: string | null; label?: string; action?: ActionSpec | StatusAction | null },
): FactSpec<D> {
  const action = extra.action === undefined ? mapping.action : (extra.action ?? undefined);
  return {
    phase: mapping.phase,
    kind: mapping.kind,
    priority: mapping.priority,
    label: extra.label ?? mapping.label,
    detail: extra.detail,
    action,
    raw: extra.raw,
  };
}

/** 插值文案：先为固定前后缀留出空间，再截断插值，避免关键尾句被整体截断吞掉。 */
function withValue(prefix: string, value: string, suffix = ''): string {
  const budget = Math.max(LABEL_LIMIT - prefix.length - suffix.length, 1);
  return `${prefix}${truncateText(redactSecrets(value), budget)}${suffix}`;
}

const joinDetail = (...parts: Array<string | null | undefined>) => parts.filter((part): part is string => !!part).join(' · ') || undefined;

const globalScope = (): StatusScope => ({ kind: 'global' });
const workspaceScope = (workspaceId: string): StatusScope => ({ kind: 'workspace', workspaceId });
const resourceScope = (workspaceId: string, resourceId: string): StatusScope => ({ kind: 'resource', workspaceId, resourceId });
const sessionScope = (workspaceId: string, sessionId: string): StatusScope => ({ kind: 'session', workspaceId, sessionId });

/* ---------- 映射表（协议新增枚举值而未映射时编译失败） ---------- */

const TERMINAL_CONNECT: ActionSpec = { id: 'terminal.connect', label: '连接终端' };
const TERMINAL_STATE = {
  idle: { phase: 'idle', kind: 'steady', priority: 10, label: '尚未连接', action: TERMINAL_CONNECT },
  starting: { phase: 'pending', kind: 'progress', priority: 60, label: '正在连接…' },
  running: { phase: 'ok', kind: 'steady', priority: 10, label: '已连接' },
  closing: { phase: 'pending', kind: 'progress', priority: 60, label: '正在关闭并核实进程…' },
  closed: { phase: 'idle', kind: 'confirmation', priority: 20, label: '已关闭，所属进程已确认退出', action: TERMINAL_CONNECT },
  failed: { phase: 'failed', kind: 'problem', priority: 60, label: '连接失败', action: TERMINAL_CONNECT },
} satisfies Record<TerminalSnapshot['state'], Mapping>;

const APP_NEW: Mapping = {
  phase: 'idle',
  kind: 'steady',
  priority: 10,
  label: '尚未创建 App',
  action: { id: 'app.create', label: '新建 App' },
};
const APP_START: ActionSpec = { id: 'app.start', label: '启动应用' };
const APP_STATE = {
  created: { phase: 'idle', kind: 'steady', priority: 10, label: '已创建', action: APP_START },
  starting: { phase: 'pending', kind: 'progress', priority: 60, label: '正在启动应用…' },
  running: { phase: 'ok', kind: 'steady', priority: 10, label: '服务运行中' },
  stopping: { phase: 'pending', kind: 'progress', priority: 60, label: '正在停止应用…' },
  stopped: { phase: 'idle', kind: 'steady', priority: 10, label: '已停止', action: APP_START },
  failed: { phase: 'failed', kind: 'problem', priority: 60, label: '应用运行失败', action: { id: 'app.manage', label: '管理 App' } },
} satisfies Record<ManagedApp['state'], Mapping>;

const RUN_CANCEL: ActionSpec = { id: 'run.cancel', label: '取消回复' };
const RUN_STATE = {
  starting: { phase: 'pending', kind: 'progress', priority: 70, label: '正在启动…', action: RUN_CANCEL },
  running: { phase: 'active', kind: 'progress', priority: 70, label: '正在执行…', action: RUN_CANCEL },
  cancelling: { phase: 'pending', kind: 'progress', priority: 75, label: '正在取消并核实退出…' },
  completed: { phase: 'ok', kind: 'steady', priority: 10, label: '执行完成' },
  cancelled: { phase: 'idle', kind: 'steady', priority: 10, label: '已取消' },
  failed: { phase: 'failed', kind: 'problem', priority: 70, label: '执行失败' },
  interrupted: { phase: 'failed', kind: 'problem', priority: 65, label: '执行中断' },
} satisfies Record<WorkbenchRun['state'], Mapping>;

type ValidationState = WorkbenchRun['validation']['state'];
type Applicability = WorkbenchRun['validation']['applicability'];
const VALIDATION_STATE = {
  not_run: { phase: 'idle', kind: 'steady', priority: 10, label: '尚未检查' },
  running: { phase: 'active', kind: 'progress', priority: 55, label: '正在检查…' },
  passed: { phase: 'ok', kind: 'steady', priority: 10, label: '检查通过' },
  failed: { phase: 'failed', kind: 'problem', priority: 60, label: '检查未通过' },
  blocked: { phase: 'degraded', kind: 'problem', priority: 55, label: '检查无法执行' },
} satisfies Record<ValidationState, Mapping>;

/** current 不产出事实：检查适用于当前版本是默认状态。 */
const VALIDATION_APPLICABILITY = {
  current: null,
  stale: { phase: 'degraded', kind: 'problem', priority: 50, label: '检查已不适用于当前版本' },
  unknown: { phase: 'unknown', kind: 'steady', priority: 10, label: '检查适用性未知' },
} satisfies Record<Applicability, Mapping | null>;

const REVIEW_STATE = {
  none: { phase: 'idle', kind: 'steady', priority: 10, label: '尚未审阅' },
  accepted: { phase: 'ok', kind: 'steady', priority: 10, label: '已接受' },
  changes_requested: { phase: 'idle', kind: 'steady', priority: 10, label: '已要求修改' },
} satisfies Record<'none' | NonNullable<WorkbenchRun['review']>['decision'], Mapping>;

const CONTEXT_APPLICABILITY = {
  current: { phase: 'ok', kind: 'steady', priority: 10, label: '现场适用性：有效' },
  stale: {
    phase: 'degraded',
    kind: 'problem',
    priority: 45,
    label: '现场适用性：已失效',
    action: { id: 'context.recapture', label: '重新选择元素' },
  },
  unknown: { phase: 'unknown', kind: 'steady', priority: 10, label: '现场适用性：未知' },
} satisfies Record<WorkbenchSession['contextApplicability'], Mapping>;

type CaptureState = NonNullable<WorkbenchSession['captureRequest']>['state'];
/** 采集完成 / 已取消不产出事实：结果由上下文本身呈现。 */
const CAPTURE_STATE = {
  pending: {
    phase: 'active',
    kind: 'progress',
    priority: 65,
    label: '正在采集…',
    action: { id: 'web.cancelPick', label: '取消采集' },
  },
  failed: { phase: 'failed', kind: 'problem', priority: 40, label: '采集失败' },
  completed: null,
  cancelled: null,
} satisfies Record<CaptureState, Mapping | null>;

const AGENT_CONTROL = {
  idle: null,
  active: { phase: 'active', kind: 'control', priority: 100, label: 'AI 正在操控此页面' },
  paused_by_user: {
    phase: 'degraded',
    kind: 'control',
    priority: 110,
    label: '已暂停 AI 操控：检测到你在页面中的操作',
    action: { id: 'web.resumeAgent', label: '允许 AI 继续' },
  },
} satisfies Record<AgentControlState['state'], Mapping | null>;

const CDP_STATE = {
  attached: null,
  idle: null,
  detached: {
    phase: 'degraded',
    kind: 'problem',
    priority: 30,
    label: '页面控制已断开',
    action: { id: 'web.reattach', label: '重新附着' },
  },
} satisfies Record<CdpState['state'], Mapping | null>;

/** 只有 pending / failed 产出状态事实；completed / cancelled 不产出。 */
const OBSERVATION_STATE = {
  pending: {
    phase: 'active',
    kind: 'progress',
    priority: 55,
    label: '正在读取…',
    action: { id: 'observation.cancel', label: '取消读取' },
  },
  failed: { phase: 'failed', kind: 'problem', priority: 50, label: '读取失败' },
  completed: null,
  cancelled: null,
} satisfies Record<ObservationRecord['state'], Mapping | null>;

const OBSERVATION_COVERAGE = {
  complete: { phase: 'ok', kind: 'steady', priority: 10, label: '覆盖完整' },
  partial: { phase: 'degraded', kind: 'problem', priority: 40, label: '覆盖不完整' },
  unknown: { phase: 'unknown', kind: 'problem', priority: 35, label: '覆盖情况未知' },
} satisfies Record<Observation['coverage']['status'], Mapping>;

/** 错误标签：沿用现有界面文案（Observation.tsx errorNames 与 e2e/ssh-product.spec.ts 断言的「未获授权」）；修订 1 的对照表不在仓库中。 */
export const OBSERVATION_ERROR_LABEL = {
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
} satisfies Record<ObservationError['error'], string>;

const FILE_CHANGE_LABEL = {
  change: '内容已变化',
  rename: '已重命名',
  delete: '已删除',
  unknown: '变化未知',
  root_replaced: '根目录被替换',
  closed: '已关闭',
} satisfies Record<FileInvalidationHint['change'], string>;

const SETUP_PROVIDER_LABEL = { docker: 'Docker', openai: 'OpenAI' } satisfies Record<
  NonNullable<SetupSnapshot['pendingLogin']>['provider'],
  string
>;

/* ---------- 全局：chat / execution / setup / storage ---------- */

function chatFacts(chat: ChatStatus | null): StatusFact[] {
  const entity: Entity<'chat'> = { domain: 'chat', entityId: 'global', scope: globalScope(), instanceToken: 'global' };
  if (!chat) {
    return [build(entity, 'state', { phase: 'pending', kind: 'steady', priority: 10, label: '正在读取对话状态', raw: {} })];
  }
  if (chat.available) {
    return [
      build(entity, 'state', {
        phase: 'ok',
        kind: 'steady',
        priority: 10,
        label: '对话可用',
        detail: joinDetail(chat.version, chat.sandbox, chat.cwd),
        raw: { available: true },
      }),
    ];
  }
  return [
    build(entity, 'state', {
      phase: 'failed',
      kind: 'problem',
      priority: 80,
      label: '对话不可用',
      detail: chat.reason,
      action: { id: 'nav.settings', label: '查看设置' },
      raw: { available: false },
    }),
  ];
}

/** 固定比赛执行与验收服务（T04）未接入是能力说明，不是故障；任意输入都只产出 capability，且无动作。 */
function executionFacts(execution: ExecutionStatus | null): StatusFact[] {
  if (!execution) return [];
  const entity: Entity<'execution'> = { domain: 'execution', entityId: 'global', scope: globalScope(), instanceToken: 'global' };
  return [
    build(entity, 'state', {
      phase: 'idle',
      kind: 'capability',
      priority: 0,
      label: '比赛执行与验收（T04）：尚未接入',
      detail: execution.reason,
      raw: { available: execution.available, harnessState: execution.harness.state },
    }),
  ];
}

function setupFacts(setup: SetupSnapshot | null): StatusFact[] {
  if (!setup) return [];
  const entity = (token: string): Entity<'setup'> => ({ domain: 'setup', entityId: 'global', scope: globalScope(), instanceToken: token });
  const open: ActionSpec = { id: 'nav.setup', label: '打开安装' };
  const facts: StatusFact[] = [];
  if (setup.stage !== 'ready')
    facts.push(
      build(entity('global'), 'state', {
        phase: 'degraded',
        kind: 'problem',
        priority: 70,
        label: '比赛环境未就绪',
        action: open,
        raw: { stage: setup.stage, busy: setup.busy },
      }),
    );
  if (setup.error)
    facts.push(
      build(entity('global'), 'error', {
        phase: 'failed',
        kind: 'problem',
        priority: 75,
        label: '环境安装出错',
        detail: setup.error.message,
        action: open,
        raw: { stage: setup.stage, busy: setup.busy, errorCode: setup.error.code },
      }),
    );
  if (setup.pendingLogin)
    facts.push(
      build(entity(setup.pendingLogin.id), 'login', {
        phase: 'active',
        kind: 'progress',
        priority: 50,
        label: `等待 ${SETUP_PROVIDER_LABEL[setup.pendingLogin.provider]} 登录完成`,
        raw: { stage: setup.stage, busy: setup.busy },
      }),
    );
  if (setup.restartRequired)
    facts.push(
      build(entity('global'), 'restart', {
        phase: 'degraded',
        kind: 'problem',
        priority: 30,
        label: '设置已保存，重启后生效',
        raw: { restartRequired: true },
      }),
    );
  return facts;
}

function storageFacts(snapshot: WorkbenchSnapshot): StatusFact[] {
  if (!snapshot.storageError) return [];
  const entity: Entity<'storage'> = { domain: 'storage', entityId: 'global', scope: globalScope(), instanceToken: 'global' };
  return [
    build(entity, 'state', {
      phase: 'failed',
      kind: 'problem',
      priority: 90,
      label: withValue('持久化失败：', snapshot.storageError, '。当前状态仅保留在内存中'),
      detail: snapshot.storageError.length > 80 ? snapshot.storageError : undefined,
      raw: {},
    }),
  ];
}

/* ---------- 终端 ---------- */

/** 终端不可用的原因：资源自带的原因优先；否则环境没有终端能力时取环境的原因（环境未核对 / 未配置时给通用说明）。 */
function terminalUnavailableReason(resource: WorkbenchResource, environments: readonly EnvironmentDescription[]): string | null {
  if (resource.unavailableReason) return resource.unavailableReason;
  const environment = environments.find((item) => item.environmentId === resource.environmentId);
  return environment?.capabilities.terminal ? null : (environment?.reason ?? '环境能力尚未核对或终端未配置');
}

function terminalFacts(workspaceId: string, resource: WorkbenchResource, environments: readonly EnvironmentDescription[]): StatusFact[] {
  const terminal = resource.terminal;
  const state = terminal?.state ?? 'idle';
  const entity: Entity<'terminal'> = {
    domain: 'terminal',
    entityId: resource.resourceId,
    scope: resourceScope(workspaceId, resource.resourceId),
    instanceToken: `${resource.instanceId ?? 'none'}:${terminal?.sessionId ?? 'none'}`,
  };
  const raw = {
    instanceId: resource.instanceId,
    sessionId: terminal?.sessionId,
    state,
    cleanupPending: terminal?.cleanupPending,
    environmentId: resource.environmentId,
    outputOffset: terminal?.outputOffset,
  };
  const mapping: Mapping = TERMINAL_STATE[state];
  // 进程退出未确认（含 SSH 断线）时连接动作禁用，与「重连明确拒绝」一致。
  const action = mapping.action && terminal?.cleanupPending ? { ...mapping.action, disabled: true } : mapping.action;
  const facts: StatusFact[] = [
    build(
      entity,
      'state',
      fromMapping(mapping, {
        raw,
        action,
        detail:
          state === 'running'
            ? joinDetail(terminal?.sandbox, terminal?.cwd)
            : state === 'failed'
              ? (terminal?.error ?? undefined)
              : undefined,
      }),
    ),
  ];
  // 运行中的 PTY 本来就持有进程（cleanupPending 为 true）：starting / running / closing 由 state 文案表达，
  // 只有进程应已结束（failed / closed / idle）却仍未确认时才是「未确认」事实。
  if (terminal?.cleanupPending && (state === 'failed' || state === 'closed' || state === 'idle'))
    facts.push(build(entity, 'cleanup', { phase: 'unknown', kind: 'unresolved', priority: 90, label: '所属进程退出未确认', raw }));
  const unavailable = terminalUnavailableReason(resource, environments);
  if (unavailable)
    facts.push(
      build(entity, 'unavailable', {
        phase: 'degraded',
        kind: 'problem',
        priority: 40,
        label: unavailable,
        detail: unavailable.length > LABEL_LIMIT ? unavailable : undefined,
        raw,
      }),
    );
  return facts;
}

/* ---------- 网页 ---------- */

function webFacts(workspaceId: string, resource: WorkbenchResource): StatusFact[] {
  const preview = resource.preview;
  const entity: Entity<'web'> = {
    domain: 'web',
    entityId: resource.resourceId,
    scope: resourceScope(workspaceId, resource.resourceId),
    instanceToken: `${resource.instanceId ?? 'none'}:${preview?.page.documentGeneration ?? 'none'}`,
  };
  const base = { instanceId: resource.instanceId, documentGeneration: preview?.page.documentGeneration };
  const facts: StatusFact[] = [];
  if (preview) {
    const agent = preview.agentControl?.state ?? 'idle';
    const control = AGENT_CONTROL[agent];
    if (control)
      facts.push(
        build(
          entity,
          'agent-control',
          fromMapping(control, {
            raw: { ...base, agentControlState: agent },
            label:
              agent === 'active'
                ? withValue(
                    'AI 正在操控此页面（',
                    truncateText(redactSecrets(preview.agentControl?.lastAction ?? '操作'), 40),
                    '）。你在页面中点击或输入会立即暂停 AI',
                  )
                : undefined,
          }),
        ),
      );
    if (preview.picking)
      facts.push(
        build(entity, 'picking', {
          phase: 'active',
          kind: 'progress',
          priority: 65,
          label: '选择中 · Esc 取消',
          action: { id: 'web.cancelPick', label: '取消选择' },
          raw: base,
        }),
      );
    // problem 内优先级：load-error 50 > pick-error 40 > cdp 30 > blocked-nav 20 > unavailable 10
    if (preview.loadError)
      facts.push(
        build(entity, 'load-error', {
          phase: 'failed',
          kind: 'problem',
          priority: 50,
          label: withValue('页面加载失败：', preview.loadError.description),
          action: { id: 'web.reload', label: '重新加载' },
          raw: { ...base, loadErrorCode: preview.loadError.code },
        }),
      );
    if (preview.pickError)
      facts.push(
        build(entity, 'pick-error', {
          phase: 'failed',
          kind: 'problem',
          priority: 40,
          label: withValue('元素选择失败：', preview.pickError),
          raw: base,
        }),
      );
    if (preview.blockedNavigation)
      facts.push(
        build(entity, 'blocked-nav', {
          phase: 'degraded',
          kind: 'problem',
          priority: 20,
          label: withValue('已拦截导航：', redactUrl(preview.blockedNavigation)),
          raw: base,
        }),
      );
    const cdp = CDP_STATE[preview.cdp.state];
    if (cdp) facts.push(build(entity, 'cdp', fromMapping(cdp, { raw: { ...base, cdpState: preview.cdp.state } })));
  }
  if (resource.unavailableReason)
    facts.push(
      build(entity, 'unavailable', {
        phase: 'degraded',
        kind: 'problem',
        priority: 10,
        label: resource.unavailableReason,
        detail: resource.unavailableReason.length > LABEL_LIMIT ? resource.unavailableReason : undefined,
        raw: base,
      }),
    );
  if (preview?.loading) facts.push(build(entity, 'state', { phase: 'active', kind: 'steady', priority: 10, label: '正在加载', raw: base }));
  if (preview && preview.consoleIssueCount > 0)
    facts.push(
      build(entity, 'console', {
        phase: 'degraded',
        kind: 'steady',
        priority: 10,
        label: `页面有 ${preview.consoleIssueCount} 条错误或警告`,
        raw: { ...base, consoleIssueCount: preview.consoleIssueCount },
      }),
    );
  return facts;
}

/* ---------- 受管 App ---------- */

function appFacts(workspace: WorkspaceSnapshot): StatusFact[] {
  const app = workspace.managedApp;
  const entity: Entity<'app'> = {
    domain: 'app',
    entityId: workspace.workspaceId,
    scope: workspaceScope(workspace.workspaceId),
    instanceToken: app?.appInstanceId ?? 'none',
  };
  if (!app) return [build(entity, 'state', fromMapping(APP_NEW, { raw: { projectId: workspace.app?.projectId } }))];
  const raw = {
    appInstanceId: app.appInstanceId,
    projectId: app.projectId,
    state: app.state,
    cleanupConfirmed: app.cleanupConfirmed,
    guestPort: app.guestPort,
  };
  const facts = [
    build(entity, 'state', fromMapping(APP_STATE[app.state], { raw, detail: app.state === 'failed' ? app.error : undefined })),
  ];
  // 服务端把清理未确认记为 failed（或 stopped）+ cleanupConfirmed:false；starting / running / stopping 期间进程本来就在，不算未确认。
  if ((app.state === 'stopped' || app.state === 'failed') && !app.cleanupConfirmed)
    facts.push(build(entity, 'cleanup', { phase: 'unknown', kind: 'unresolved', priority: 80, label: '应用进程清理未确认', raw }));
  return facts;
}

/* ---------- 运行、检查、审阅 ---------- */

export function sourceChangeStatus(run: WorkbenchRun): Mapping & { detail?: string } {
  const source = run.sourceChange;
  if (!source)
    return run.state === 'starting'
      ? { phase: 'pending', kind: 'progress', priority: 45, label: '正在采集源码基线…' }
      : { phase: 'unknown', kind: 'capability', priority: 5, label: '此历史运行未记录源码差异' };
  if (source.state === 'unavailable')
    return { phase: 'degraded', kind: 'capability', priority: 5, label: '源码差异不可用', detail: source.reason };
  if (source.state === 'captured')
    return {
      phase: 'ok',
      kind: 'steady',
      priority: 5,
      label: source.baseTree === source.afterTree ? '源码无改动' : source.truncated ? '源码差异已采集（有截断）' : '源码差异已采集',
    };
  if (['starting', 'running'].includes(run.state))
    return { phase: 'pending', kind: 'steady', priority: 5, label: '源码基线已保存，等待执行结束' };
  if ((run.cleanupPending || run.state === 'cancelling') && !run.sourceCleanupPending)
    return { phase: 'unknown', kind: 'unresolved', priority: 45, label: '等待清理确认后采集源码差异…' };
  return { phase: 'active', kind: 'progress', priority: 45, label: '正在采集结束源码…' };
}

function runFacts(workspaceId: string, run: WorkbenchRun): StatusFact[] {
  const scope = sessionScope(workspaceId, run.sessionId);
  const run_: Entity<'run'> = { domain: 'run', entityId: run.runId, scope, instanceToken: run.runId };
  const raw = {
    state: run.state,
    cleanupPending: run.cleanupPending,
    appCleanupPending: run.appCleanupPending,
    sourceCleanupPending: run.sourceCleanupPending,
    executorState: run.executorState,
    cleanupRetryAvailable: run.cleanupRetryAvailable,
    cleanupReconciling: run.cleanupReconciling,
    taskVersionId: run.taskVersionId,
  };
  const facts: StatusFact[] = [
    build(run_, 'state', fromMapping(RUN_STATE[run.state], { raw, detail: run.state === 'failed' ? run.error : undefined })),
  ];
  if (run.sourceChange)
    facts.push(
      build(run_, 'source-change', {
        ...sourceChangeStatus(run),
        raw: { state: run.state, taskVersionId: run.taskVersionId, sourceChangeState: run.sourceChange.state },
      }),
    );
  // 执行期间（starting / running / cancelling）进程本来就在；只有 run 已进入终态仍未核实退出时才产出。
  if (run.cleanupPending && ['completed', 'cancelled', 'failed', 'interrupted'].includes(run.state))
    facts.push(build(run_, 'process-cleanup', { phase: 'unknown', kind: 'unresolved', priority: 85, label: '正在核实所属进程退出…', raw }));
  // App 数据操作待确认：只要 appCleanupPending 就产出。执行器已确认无待清理时说明「模型已停止」；
  // executorState 缺失或仍待清理（如重启恢复路径）时只说明 App 数据操作结果待确认。可与 cancelling 同时成立，两条都产出。
  if (run.appCleanupPending)
    facts.push(
      build(run_, 'app-cleanup', {
        phase: 'unknown',
        kind: 'unresolved',
        priority: 95,
        label: run.executorState?.cleanupPending === false ? '模型已停止，App 数据操作仍待确认' : 'App 数据操作结果待确认',
        action: run.cleanupRetryAvailable
          ? { id: 'run.reconcileCleanup', label: '重新核对', ...(run.cleanupReconciling ? { disabled: true } : {}) }
          : undefined,
        raw,
      }),
    );

  if (run.sourceCleanupPending && run.sourceChange?.state === 'unavailable')
    facts.push(
      build(run_, 'source-cleanup', {
        phase: 'unknown',
        kind: 'unresolved',
        priority: 95,
        label: '源码 helper 清理未确认，项目仍被占用',
        raw,
      }),
    );

  const validation: Entity<'validation'> = { domain: 'validation', entityId: run.runId, scope, instanceToken: run.runId };
  const validationRaw = {
    state: run.validation.state,
    applicability: run.validation.applicability,
    candidateId: run.candidateId,
  };
  facts.push(
    build(
      validation,
      'state',
      fromMapping(VALIDATION_STATE[run.validation.state], {
        raw: validationRaw,
        detail: run.validation.state === 'failed' || run.validation.state === 'blocked' ? run.validation.reason : undefined,
      }),
    ),
  );
  const applicability = VALIDATION_APPLICABILITY[run.validation.applicability];
  if (applicability) facts.push(build(validation, 'applicability', fromMapping(applicability, { raw: validationRaw })));

  const review: Entity<'review'> = { domain: 'review', entityId: run.runId, scope, instanceToken: run.runId };
  facts.push(
    build(
      review,
      'state',
      fromMapping(REVIEW_STATE[run.review?.decision ?? 'none'], {
        raw: { decision: run.review?.decision ?? null, candidateId: run.candidateId },
      }),
    ),
  );
  return facts;
}

/* ---------- 会话上下文 ---------- */

function contextFacts(workspaceId: string, session: WorkbenchSession): StatusFact[] {
  const request = session.captureRequest;
  const entity: Entity<'context'> = {
    domain: 'context',
    entityId: session.sessionId,
    scope: sessionScope(workspaceId, session.sessionId),
    instanceToken: `${session.sessionId}:${request?.requestId ?? 'none'}`,
  };
  const raw = {
    applicability: session.contextApplicability,
    captureRequestId: request?.requestId ?? null,
    captureState: request?.state,
  };
  const facts: StatusFact[] = [build(entity, 'applicability', fromMapping(CONTEXT_APPLICABILITY[session.contextApplicability], { raw }))];
  const capture = request ? CAPTURE_STATE[request.state] : null;
  if (capture)
    facts.push(build(entity, 'capture', fromMapping(capture, { raw, detail: request?.state === 'failed' ? request.error : undefined })));
  if (session.historyRestored)
    facts.push(
      // 历史恢复是会话级事实，不随采集请求更换而失效，token 只取 sessionId。
      build({ ...entity, instanceToken: session.sessionId }, 'history-restored', {
        phase: 'degraded',
        kind: 'confirmation',
        priority: 10,
        label: '历史已恢复；新执行不会自动延续旧模型上下文。',
        raw,
      }),
    );
  return facts;
}

/* ---------- 观察与文件 ---------- */

function observationFacts(workspaceId: string, owner: string | null, record: ObservationRecord): StatusFact[] {
  const request = record.request;
  const target = request.target;
  const sessionId = owner ?? request.sessionId;
  const scope = sessionId
    ? sessionScope(workspaceId, sessionId)
    : target
      ? resourceScope(workspaceId, target.resourceId)
      : workspaceScope(workspaceId);
  const entity: Entity<'observation'> = { domain: 'observation', entityId: request.requestId, scope, instanceToken: request.requestId };
  const result = record.result;
  const error = result && 'error' in result ? result : null;
  const observed = result && 'coverage' in result ? result : null;
  const raw = {
    tool: request.tool,
    state: record.state,
    coverageStatus: observed?.coverage.status,
    revisionStrength: observed?.revision.strength,
    errorCode: error?.error,
  };
  const facts: StatusFact[] = [];
  const state = OBSERVATION_STATE[record.state];
  if (state)
    facts.push(
      build(
        entity,
        'state',
        fromMapping(state, {
          raw,
          label: record.state === 'failed' ? `读取失败：${error ? OBSERVATION_ERROR_LABEL[error.error] : '原因未记录'}` : undefined,
          detail: record.state === 'failed' ? error?.message : undefined,
        }),
      ),
    );
  if (observed)
    facts.push(
      build(
        entity,
        'coverage',
        fromMapping(OBSERVATION_COVERAGE[observed.coverage.status], {
          raw,
          detail: observed.coverage.reasons?.length ? observed.coverage.reasons.join('、') : undefined,
        }),
      ),
    );
  return facts;
}

function fileFacts(workspaceId: string, resource: WorkbenchResource): StatusFact[] {
  if (resource.environmentId && !resource.unavailableReason) return [];
  const label = resource.unavailableReason || '此资源没有授权环境，请新建标签并明确选择已配置环境。';
  const entity: Entity<'file'> = {
    domain: 'file',
    entityId: resource.resourceId,
    scope: resourceScope(workspaceId, resource.resourceId),
    instanceToken: `${resource.instanceId ?? 'none'}:${resource.generation}`,
  };
  return [
    build(entity, 'unavailable', {
      phase: 'degraded',
      kind: 'problem',
      priority: 60,
      label,
      detail: resource.unavailableReason && resource.unavailableReason.length > LABEL_LIMIT ? resource.unavailableReason : undefined,
      raw: {},
    }),
  ];
}

function fileHintFact(workspaceId: string, hint: FileInvalidationHint): StatusFact {
  const entity: Entity<'file'> = {
    domain: 'file',
    entityId: hint.resourceId,
    scope: resourceScope(workspaceId, hint.resourceId),
    instanceToken: `${hint.instanceId}:${hint.instanceGeneration}:${hint.watchGeneration}`,
  };
  return build(entity, 'hint', {
    phase: 'degraded',
    kind: 'problem',
    priority: 45,
    label: `文件可能变化 · ${FILE_CHANGE_LABEL[hint.change]}；请重新读取`,
    raw: { change: hint.change },
  });
}

/* ---------- 入口 ---------- */

function workspaceFacts(workspace: WorkspaceSnapshot, environments: readonly EnvironmentDescription[]): StatusFact[] {
  const workspaceId = workspace.workspaceId;
  const facts: StatusFact[] = [...appFacts(workspace)];
  for (const resource of workspace.resources) {
    if (resource.kind === 'web') facts.push(...webFacts(workspaceId, resource));
    else if (resource.kind === 'terminal' || resource.kind === 'ssh') facts.push(...terminalFacts(workspaceId, resource, environments));
    else if (resource.kind === 'file') facts.push(...fileFacts(workspaceId, resource));
  }
  for (const session of workspace.sessions) facts.push(...contextFacts(workspaceId, session));
  for (const run of workspace.runs) facts.push(...runFacts(workspaceId, run));
  const seen = new Set<string>();
  const records: Array<[string | null, ObservationRecord]> = [
    ...workspace.observations.map((record): [string | null, ObservationRecord] => [null, record]),
    ...workspace.sessions.flatMap((session) =>
      session.observations.map((record): [string | null, ObservationRecord] => [session.sessionId, record]),
    ),
  ];
  for (const [owner, record] of records) {
    if (seen.has(record.request.requestId)) continue;
    seen.add(record.request.requestId);
    facts.push(...observationFacts(workspaceId, owner, record));
  }
  for (const hint of workspace.fileHints) facts.push(fileHintFact(workspaceId, hint));
  return facts;
}

/** 把 Main 已发布的快照翻译成带键的事实。纯函数：相同输入得到相同输出，不读取任何界面状态。 */
export function projectFacts(input: FactInput): StatusFact[] {
  const facts: StatusFact[] = [...chatFacts(input.chat), ...executionFacts(input.execution), ...setupFacts(input.setup)];
  if (input.snapshot) {
    facts.push(...storageFacts(input.snapshot));
    for (const workspace of input.snapshot.workspaces) facts.push(...workspaceFacts(workspace, input.snapshot.environments ?? []));
  }
  return facts;
}
