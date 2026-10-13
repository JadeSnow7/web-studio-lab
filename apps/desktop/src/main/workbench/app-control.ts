import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  APP_TOOL_LEVEL,
  AppControlErrorCodeSchema,
  AppManifestSchema,
  AppRevisionSchema,
  AppScenarioTraceSchema,
  AppToolInputSchemas,
  AppToolNameSchema,
  type AgentControlState,
  type AppAgentOperation,
  type AppAgentResult,
  type AppAuditRecord,
  type AppBridgeRequest,
  type AppBridgeResponse,
  type AppControlError,
  type AppControlResult,
  type AppLogs,
  type AppManifest,
  type AppScenario,
  type AppScenarioTrace,
  type AppTarget,
  type AppTargetSelector,
  type AppToolInput,
  type AppToolName,
  type AppUiAction,
  type AppUiSnapshot,
  type CdpState,
  type ManagedApp,
  type ObservationTurnScope,
} from '@wsl/protocol';
import { AppControlFailure } from './app-control-failure';

/**
 * 受管 App 控制面的唯一 dispatcher（ADR-0002）。授权事实由 WorkbenchApplication 冻结提供，
 * CDP 与 service 执行器经端口注入；本模块不导入 Electron，也不持有 run/App 业务状态。
 */
export interface AppControlContext {
  workspaceId: string;
  sessionId: string;
  runId: string;
  /** TaskVersion.allowedScopes 含 app.data.reset（用户确认任务时写明）。 */
  allowsReset: boolean;
  executionBinding?: { generation: string; turnId: string | null };
  app: Pick<ManagedApp, 'projectId' | 'appInstanceId' | 'state' | 'url' | 'cleanupConfirmed' | 'error'> | null;
  browser: { resourceId: string; instanceId: string | null; generation: number } | null;
}
export interface AppUiPort {
  identity(): { documentGeneration: number; url: string; cdp: CdpState; agentControl: AgentControlState };
  snapshot(appInstanceId: string, options: { limit: number; includeHidden: boolean }, signal: AbortSignal): Promise<AppUiSnapshot>;
  act(
    action: AppUiAction,
    binding: { runId: string; documentGeneration: number },
    signal: AbortSignal,
  ): Promise<{ documentGeneration: number; navigated: boolean; url: string }>;
  query(
    target: AppTargetSelector,
    signal: AbortSignal,
  ): Promise<{ count: number; visible: boolean; enabled: boolean; text: string | null }>;
  bridge(request: AppBridgeRequest, signal: AbortSignal): Promise<AppBridgeResponse>;
  screenshot(): Promise<Buffer>;
  consoleMark(): number;
  consoleErrorsSince(mark: number): string[];
  beginControl(runId: string, label: string): void;
  releaseRun(runId: string): void;
}
const PendingOperationSchema = z
  .object({
    operationId: z.uuid(),
    workspaceId: z.string(),
    projectId: z.string(),
    appInstanceId: z.string().nullable(),
    runId: z.string(),
    sessionId: z.string(),
    generation: z.string().nullable(),
    turnId: z.string().nullable(),
    kind: z.enum(['data', 'cli']),
    operation: z.enum(['seed', 'reset', 'describe', 'query', 'snapshot']),
  })
  .strict();
type PendingOperation = z.infer<typeof PendingOperationSchema>;
export interface AppControlStore {
  loadPending?(): Promise<PendingOperation[]>;
  savePending?(operations: PendingOperation[]): Promise<void>;
  appendAudit(record: AppAuditRecord): Promise<void>;
  writeEvidence(runId: string, scenarioRunId: string, name: string, data: string | Buffer): Promise<string>;
}
export interface AppControlPorts {
  context(scope: ObservationTurnScope): Promise<AppControlContext>;
  ui(resourceId: string): AppUiPort;
  agent(target: AppTarget, appInstanceId: string | null, operation: AppAgentOperation, signal: AbortSignal): Promise<AppAgentResult>;
  logs(target: AppTarget, maxBytes: number): Promise<AppLogs>;
  leaseValid(projectId: string, appInstanceId: string): boolean;
  restart(workspaceId: string, appInstanceId: string): void;
  store: AppControlStore;
  timeoutMs?: number;
  pendingChanged?(workspaceId: string, runId: string): void;
}

const RULES = [
  '语义命令只用于准备数据与观察状态：seed、读 state、读日志、读库。',
  '判定“用户能完成某操作”必须经 app.ui.act 的 UI 动作，再用状态断言佐证；禁止用语义命令直接制造被验收的行为结果。',
  '固定验收基准在 Agent 写入范围外；Agent 自写场景只是开发辅助，不算验收通过。',
];
const BEHAVIOURAL = new Set([
  'element_not_found',
  'wait_timeout',
  'element_disabled',
  'element_obscured',
  'ambiguous_target',
  'command_failed',
  'command_invalid_input',
]);
const SENSITIVE = new Set(['text', 'sql', 'input', 'value', 'equals', 'contains']);
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** 审计只记键、长度与散列；文本、SQL 与命令输入不落原文。 */
export function summarizeArgs(args: unknown): AppAuditRecord['args'] {
  const summary: Record<string, string | number | boolean | null> = {};
  const visit = (value: unknown, key: string, depth: number) => {
    if (Object.keys(summary).length >= 40) return;
    const leaf = key.split('.').at(-1) ?? key;
    if (typeof value === 'string')
      summary[key] = SENSITIVE.has(leaf) || value.length > 120 ? `len:${value.length} sha256:${sha256(value).slice(0, 16)}` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `array:${value.length} sha256:${sha256(JSON.stringify(value)).slice(0, 16)}`;
    else if (value && typeof value === 'object') {
      if (depth >= 3 || SENSITIVE.has(leaf)) summary[key] = `object sha256:${sha256(JSON.stringify(value)).slice(0, 16)}`;
      else for (const [child, inner] of Object.entries(value)) visit(inner, key ? `${key}.${child}` : child, depth + 1);
    }
  };
  visit(args ?? {}, '', 0);
  return { sha256: sha256(JSON.stringify(args ?? {})), summary };
}

function pointer(value: unknown, path: string): unknown {
  let current = value;
  for (const raw of path.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 键路径级 JSON diff，供场景证据记录前后状态变化。 */
export function jsonDiff(
  before: unknown,
  after: unknown,
  prefix = '',
  out: AppScenarioTrace['stateDiff'] = [],
): AppScenarioTrace['stateDiff'] {
  if (out.length >= 500 || isDeepStrictEqual(before, after)) return out;
  const objects =
    before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after);
  if (!objects) {
    out.push({ path: prefix || '/', before: before ?? null, after: after ?? null });
    return out;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys)
    jsonDiff((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${prefix}/${key}`, out);
  return out;
}

export class AppControl {
  private readonly inflight = new Map<string, Set<AbortController>>();
  private readonly touched = new Map<string, Set<string>>();
  private readonly writeLocks = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, PendingOperation>();
  private readonly reconciling = new Set<string>();
  private readonly retryAvailable = new Set<string>();
  private readonly loaded: Promise<void>;
  private saving = Promise.resolve();
  constructor(private readonly ports: AppControlPorts) {
    this.loaded = (ports.store.loadPending?.() ?? Promise.resolve([])).then((operations) => {
      for (const operation of operations) {
        this.pending.set(operation.operationId, operation);
        this.retryAvailable.add(operation.runId);
      }
    });
  }
  async ready() {
    await this.loaded;
  }
  hasPending(workspaceId: string, runId?: string) {
    return [...this.pending.values()].some((operation) => operation.workspaceId === workspaceId && (!runId || operation.runId === runId));
  }
  canRetryCleanup(runId: string) {
    return this.retryAvailable.has(runId);
  }
  isReconciling(runId: string) {
    return this.reconciling.has(runId);
  }
  private savePending() {
    const saving = this.saving.then(() => this.ports.store.savePending?.([...this.pending.values()]));
    this.saving = saving.then(
      () => undefined,
      () => undefined,
    );
    return saving;
  }
  private removePending(operationIds: string[]) {
    const saving = this.saving.then(async () => {
      await this.ports.store.savePending?.([...this.pending.values()].filter((item) => !operationIds.includes(item.operationId)));
      for (const id of operationIds) this.pending.delete(id);
      for (const runId of this.retryAvailable)
        if (![...this.pending.values()].some((item) => item.runId === runId)) this.retryAvailable.delete(runId);
    });
    this.saving = saving.then(
      () => undefined,
      () => undefined,
    );
    return saving;
  }
  async confirmStopped(workspaceId: string, projectId: string, appInstanceId: string | null) {
    await this.loaded;
    const settled = [...this.pending.values()].filter(
      (operation) =>
        operation.workspaceId === workspaceId &&
        operation.projectId === projectId &&
        (operation.appInstanceId === appInstanceId || operation.kind === 'cli'),
    );
    await this.removePending(settled.map((operation) => operation.operationId));
    for (const operation of settled) this.ports.pendingChanged?.(workspaceId, operation.runId);
  }
  async reconcileRun(workspaceId: string, runId: string) {
    await this.loaded;
    if (this.reconciling.has(runId)) return;
    this.reconciling.add(runId);
    this.ports.pendingChanged?.(workspaceId, runId);
    try {
      const operations = [...this.pending.values()].filter((item) => item.workspaceId === workspaceId && item.runId === runId);
      if (operations.length > 1) throw new Error('单项目控制面存在多个未确认操作，归属不变量被破坏');
      for (const operation of operations) {
        const result = await this.ports.agent(
          { workspaceId, projectId: operation.projectId },
          operation.appInstanceId,
          operation.kind === 'cli'
            ? { op: 'reconcile-cli' }
            : { op: 'reconcile', operationId: operation.operationId, operation: operation.operation as 'seed' | 'reset' },
          new AbortController().signal,
        );
        await this.acceptReceipt(operation, result);
      }
    } finally {
      this.reconciling.delete(runId);
      this.ports.pendingChanged?.(workspaceId, runId);
    }
  }
  /** 新的只读请求可因启动竞态切到 HTTP；核对请求不能据此推断旧 CLI 已退出。 */
  private async acceptReceipt(pending: PendingOperation, result: AppAgentResult, allowHttpReadCompletion = false) {
    const receipt = result.operation;
    if (
      result.operationDispatched === false ||
      (pending.kind === 'cli' && result.cleanupConfirmed && (result.mode === 'cli' || allowHttpReadCompletion))
    ) {
      await this.removePending([pending.operationId]);
      this.ports.pendingChanged?.(pending.workspaceId, pending.runId);
      return;
    }
    if (
      !receipt ||
      !receipt.envelope ||
      receipt.state === 'running' ||
      receipt.operationId !== pending.operationId ||
      receipt.appInstanceId !== pending.appInstanceId ||
      receipt.operation !== pending.operation
    )
      return;
    await this.removePending([pending.operationId]);
    this.ports.pendingChanged?.(pending.workspaceId, pending.runId);
  }

  /** run 结束：中止该 run 的在途调用并解除 Browser 操控指示；已产生的修改保留。 */
  releaseRun(runId: string) {
    for (const controller of this.inflight.get(runId) ?? []) controller.abort();
    for (const resourceId of this.touched.get(runId) ?? []) {
      try {
        this.ports.ui(resourceId).releaseRun(runId);
      } catch {
        // 网页实例已释放时无需解除指示。
      }
    }
    this.touched.delete(runId);
  }

  async call(
    scope: ObservationTurnScope,
    toolName: string,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AppControlResult> {
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.ports.timeoutMs ?? 55000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const parsedTool = AppToolNameSchema.safeParse(toolName);
    const tool: AppToolName | null = parsedTool.success ? parsedTool.data : null;
    const generations = { before: null as number | null, after: null as number | null };
    let context: AppControlContext | null = null;
    let result: AppControlResult;
    try {
      // 先确认 run 归属，再校验工具与参数：被拒绝的请求也绑定 run 写入审计。
      await this.loaded;
      context = await this.ports.context(scope);
      if (!tool) throw new AppControlFailure('unsupported', `未知控制面工具：${toolName}`);
      const parsed = AppToolInputSchemas[tool].safeParse(rawArgs);
      if (!parsed.success)
        throw new AppControlFailure(
          'invalid_request',
          `${tool} 参数不符合 schema`,
          parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
        );
      const runCalls = this.inflight.get(context.runId) ?? new Set();
      runCalls.add(controller);
      this.inflight.set(context.runId, runCalls);
      const refresh = async () => {
        if (controller.signal.aborted) throw new AppControlFailure(timedOut ? 'timeout' : 'cancelled', '控制面调用已停止');
        const current = await this.ports.context(scope);
        if (controller.signal.aborted) throw new AppControlFailure(timedOut ? 'timeout' : 'cancelled', '控制面调用已停止');
        if (current.runId !== context!.runId || current.workspaceId !== context!.workspaceId || current.sessionId !== context!.sessionId)
          throw new AppControlFailure('no_active_run', '请求绑定的执行已不是当前执行');
        if (current.app?.projectId !== context!.app?.projectId || current.app?.appInstanceId !== context!.app?.appInstanceId)
          throw new AppControlFailure('stale_instance', '请求绑定的应用实例已变化');
        if (
          current.browser?.resourceId !== context!.browser?.resourceId ||
          current.browser?.instanceId !== context!.browser?.instanceId ||
          current.browser?.generation !== context!.browser?.generation
        )
          throw new AppControlFailure('stale_document', '请求绑定的网页实例已变化');
        return current;
      };
      const work = async () => this.execute(tool, parsed.data as never, await refresh(), controller.signal, generations, refresh);
      const data = APP_TOOL_LEVEL[tool] === 'read' ? await work() : await this.exclusive(context.workspaceId, work);
      // Restart accepts an identity transition; all other replies belong to the frozen instance and resource.
      if (tool !== 'app.restart') await refresh();
      if (controller.signal.aborted)
        throw new AppControlFailure(timedOut ? 'timeout' : 'cancelled', timedOut ? '控制面调用超时' : '控制面调用已取消');
      result = { ok: true, tool, data };
    } catch (error) {
      result = { ok: false, tool, error: this.failure(error, controller.signal.aborted, timedOut) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (context) this.inflight.get(context.runId)?.delete(controller);
    }
    if (context) {
      try {
        await this.ports.store.appendAudit({
          recordId: randomUUID(),
          at: new Date().toISOString(),
          runId: context.runId,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          tool,
          level: tool ? APP_TOOL_LEVEL[tool] : null,
          args: summarizeArgs(rawArgs),
          outcome: result.ok ? 'ok' : result.error.code,
          appInstanceId: context.app?.appInstanceId ?? null,
          documentGenerationBefore: generations.before,
          documentGenerationAfter: generations.after,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        // 审计写入失败必须可见；已经发生的动作不能因此被报告为未发生。
        const note = `审计写入失败：${(error as Error).message}`;
        result = result.ok
          ? { ...result, data: { ...result.data, auditRecorded: false, auditError: note } }
          : { ...result, error: { ...result.error, message: `${result.error.message}；${note}` } };
      }
    }
    return result;
  }

  private failure(error: unknown, aborted: boolean, timedOut: boolean): AppControlError {
    if (error instanceof AppControlFailure)
      return {
        code: error.code,
        message: error.message.slice(0, 4000),
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    if (aborted) return { code: timedOut ? 'timeout' : 'cancelled', message: timedOut ? '控制面调用超时' : '控制面调用已取消' };
    return { code: 'unavailable', message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) };
  }

  /** 同一空间的写动作串行执行，保证场景与单步动作的确定顺序。 */
  private exclusive<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeLocks.set(workspaceId, settled);
    void settled.then(() => {
      if (this.writeLocks.get(workspaceId) === settled) this.writeLocks.delete(workspaceId);
    });
    return next;
  }

  private target(context: AppControlContext): AppTarget {
    if (!context.app) throw new AppControlFailure('app_missing', '当前空间还没有受管 App');
    return { workspaceId: context.workspaceId, projectId: context.app.projectId };
  }
  private running(context: AppControlContext): string {
    this.target(context);
    if (context.app!.state !== 'running' || !context.app!.appInstanceId)
      throw new AppControlFailure('app_not_running', `受管 App 当前为 ${context.app!.state}，需先启动`);
    return context.app!.appInstanceId;
  }
  /** 写操作门控：当前运行实例、请求绑定的 appInstanceId 与 host 租约必须一致。 */
  private writable(context: AppControlContext, appInstanceId: string, signal: AbortSignal, reservedOperationId?: string) {
    signal.throwIfAborted();
    if (
      [...this.pending.values()].some(
        (operation) => operation.workspaceId === context.workspaceId && operation.operationId !== reservedOperationId,
      )
    )
      throw new AppControlFailure('app_busy', 'App 数据操作结果仍待确认');
    const current = this.running(context);
    if (appInstanceId !== current)
      throw new AppControlFailure('stale_instance', `请求绑定的实例 ${appInstanceId} 已不是当前实例 ${current}`);
    if (!this.ports.leaseValid(context.app!.projectId, current))
      throw new AppControlFailure('stale_lease', '实例租约已失效（已停止或正在重启）');
    if (context.browser?.instanceId) {
      const control = this.ui(context).identity().agentControl;
      if (control.state === 'paused_by_user' && control.runId === context.runId)
        throw new AppControlFailure('paused_by_user', '用户已接管，需允许 AI 继续后才能写入');
    }
  }
  private ui(context: AppControlContext, runId?: string): AppUiPort {
    if (!context.browser?.instanceId) throw new AppControlFailure('browser_unavailable', '请先在空间中打开该 App 的网页标签');
    const port = this.ports.ui(context.browser.resourceId);
    if (runId) {
      const touched = this.touched.get(runId) ?? new Set();
      touched.add(context.browser.resourceId);
      this.touched.set(runId, touched);
    }
    return port;
  }
  private async agent(context: AppControlContext, operation: AppAgentOperation, signal: AbortSignal) {
    const appInstanceId = context.app?.state === 'running' ? context.app.appInstanceId : null;
    let pending: PendingOperation | undefined;
    if (context.app?.state !== 'running' && ['describe', 'query', 'snapshot'].includes(operation.op)) {
      if (this.hasPending(context.workspaceId)) throw new AppControlFailure('app_busy', 'App 控制面清理仍待确认');
      pending = {
        operationId: randomUUID(),
        workspaceId: context.workspaceId,
        projectId: context.app!.projectId,
        appInstanceId: context.app!.appInstanceId,
        runId: context.runId,
        sessionId: context.sessionId,
        generation: context.executionBinding?.generation ?? null,
        turnId: context.executionBinding?.turnId ?? null,
        kind: 'cli',
        operation: operation.op as 'describe' | 'query' | 'snapshot',
      };
      this.pending.set(pending.operationId, pending);
      await this.savePending();
    }
    let result: AppAgentResult;
    try {
      result = await this.ports.agent(this.target(context), appInstanceId, operation, signal);
      if (pending) await this.acceptReceipt(pending, result, true);
    } finally {
      if (pending) {
        if (this.pending.has(pending.operationId)) this.retryAvailable.add(context.runId);
        this.ports.pendingChanged?.(context.workspaceId, context.runId);
      }
    }
    if (result.envelope.ok) return { data: result.envelope.data, mode: result.mode, cleanupConfirmed: result.cleanupConfirmed };
    const code = AppControlErrorCodeSchema.safeParse(result.envelope.error.code);
    throw new AppControlFailure(code.success ? code.data : 'unavailable', result.envelope.error.message, {
      backendCode: result.envelope.error.code,
      mode: result.mode,
      cleanupConfirmed: result.cleanupConfirmed,
    });
  }
  /** 修订只按散列比较；manifest 的其他自述经 schema 校验后仅作描述。 */
  private async revision(context: AppControlContext, signal: AbortSignal) {
    const { data } = await this.agent(context, { op: 'describe' }, signal);
    const revision = AppRevisionSchema.safeParse(data);
    if (!revision.success) throw new AppControlFailure('unavailable', 'describe 返回格式无效');
    const manifest = AppManifestSchema.safeParse(revision.data.manifest);
    const running = context.app?.state === 'running';
    return {
      operationTrackingVersion: revision.data.operationTrackingVersion,
      currentRevision: revision.data.currentRevision,
      manifestRevision: revision.data.manifestRevision,
      buildRevision: running ? revision.data.buildRevision : null,
      manifest: manifest.success ? manifest.data : null,
      manifestError:
        revision.data.manifest === null ? 'agent/app.manifest.json 不存在' : manifest.success ? null : 'manifest 不符合 schema',
      stale: {
        manifest: !manifest.success || revision.data.manifestRevision !== revision.data.currentRevision,
        build: running ? revision.data.buildRevision !== revision.data.currentRevision : null,
      },
    };
  }
  private async fresh(context: AppControlContext, signal: AbortSignal): Promise<AppManifest> {
    const revision = await this.revision(context, signal);
    signal.throwIfAborted();
    if (!revision.manifest) throw new AppControlFailure('manifest_missing', revision.manifestError ?? 'manifest 不可用');
    if (revision.stale.manifest)
      throw new AppControlFailure('manifest_stale', 'manifest 与当前源码不一致；运行 npm run agent:manifest 后再试', {
        currentRevision: revision.currentRevision,
        manifestRevision: revision.manifestRevision,
      });
    if (revision.stale.build)
      throw new AppControlFailure('build_stale', '运行实例不是由当前源码构建；用 app.restart 重建后再试', {
        currentRevision: revision.currentRevision,
        buildRevision: revision.buildRevision,
      });
    return revision.manifest;
  }
  private bridgeData(response: AppBridgeResponse): unknown {
    if (response.ok) return response.data;
    const code =
      response.error.code === 'state_not_found'
        ? 'invalid_request'
        : response.error.code === 'invalid_request'
          ? 'invalid_request'
          : response.error.code;
    throw new AppControlFailure(code, response.error.message, response.error.issues ? { issues: response.error.issues } : undefined);
  }
  private appFacts(context: AppControlContext) {
    return context.app
      ? {
          projectId: context.app.projectId,
          appInstanceId: context.app.appInstanceId,
          state: context.app.state,
          url: context.app.url,
          cleanupConfirmed: context.app.cleanupConfirmed,
          error: context.app.error,
        }
      : null;
  }
  private browserFacts(context: AppControlContext) {
    if (!context.browser?.instanceId) return null;
    try {
      const identity = this.ports.ui(context.browser.resourceId).identity();
      return { resourceId: context.browser.resourceId, ...identity };
    } catch {
      return null;
    }
  }

  private async execute<T extends AppToolName>(
    tool: T,
    args: AppToolInput<T>,
    context: AppControlContext,
    signal: AbortSignal,
    generations: { before: number | null; after: number | null },
    refresh: () => Promise<AppControlContext>,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const input = args as AppToolInput<AppToolName> & Record<string, unknown>;
    switch (tool) {
      case 'app.describe': {
        const revision = await this.revision(context, signal);
        return { app: this.appFacts(context), browser: this.browserFacts(context), ...revision, guide: 'agent/AGENTS.md', rules: RULES };
      }
      case 'app.status':
        return { app: this.appFacts(context), browser: this.browserFacts(context), runId: context.runId };
      case 'app.logs':
        return { ...(await this.ports.logs(this.target(context), (input as AppToolInput<'app.logs'>).maxBytes)) };
      case 'app.restart': {
        const { appInstanceId } = input as AppToolInput<'app.restart'>;
        this.writable(context, appInstanceId, signal);
        this.ports.restart(context.workspaceId, appInstanceId);
        return {
          accepted: true,
          previousAppInstanceId: appInstanceId,
          next: '用 app.status 等待新实例 running；旧引用与 appInstanceId 均失效',
        };
      }
      case 'app.state.read': {
        this.running(context);
        const { names } = input as AppToolInput<'app.state.read'>;
        const ui = this.ui(context);
        generations.before = generations.after = ui.identity().documentGeneration;
        return { documentGeneration: generations.before, states: this.bridgeData(await ui.bridge({ op: 'state', names }, signal)) };
      }
      case 'app.command.list': {
        const revision = await this.revision(context, signal);
        let mounted: string[] | null = null;
        if (context.app?.state === 'running' && context.browser?.instanceId) {
          const described = this.bridgeData(await this.ui(context).bridge({ op: 'describe' }, signal)) as { commands?: unknown };
          mounted = Array.isArray(described.commands) ? described.commands.filter((name): name is string => typeof name === 'string') : [];
        }
        return {
          stale: revision.stale,
          commands: (revision.manifest?.commands ?? []).map((command) => ({
            ...command,
            mounted: mounted ? mounted.includes(command.name) : null,
          })),
        };
      }
      case 'app.command.invoke': {
        const { appInstanceId, documentGeneration, name, input: commandInput } = input as AppToolInput<'app.command.invoke'>;
        this.writable(context, appInstanceId, signal);
        const manifest = await this.fresh(context, signal);
        context = await refresh();
        this.writable(context, appInstanceId, signal);
        if (!manifest.commands.some((command) => command.name === name))
          throw new AppControlFailure(
            'command_not_found',
            `命令 ${name} 未在 manifest 登记；可用：${manifest.commands.map((command) => command.name).join(', ') || '无'}`,
          );
        const ui = this.ui(context, context.runId);
        generations.before = ui.identity().documentGeneration;
        if (generations.before !== documentGeneration)
          throw new AppControlFailure('stale_document', `页面文档代次已从 ${documentGeneration} 变为 ${generations.before}`);
        ui.beginControl(context.runId, `command:${name}`);
        const data = this.bridgeData(await ui.bridge({ op: 'invoke', name, input: commandInput }, signal));
        generations.after = ui.identity().documentGeneration;
        return { result: data ?? null, documentGeneration: generations.after };
      }
      case 'app.ui.snapshot': {
        const appInstanceId = this.running(context);
        const ui = this.ui(context);
        const { limit, includeHidden } = input as AppToolInput<'app.ui.snapshot'>;
        const snapshot = await ui.snapshot(appInstanceId, { limit, includeHidden }, signal);
        generations.before = generations.after = snapshot.documentGeneration;
        return { ...snapshot };
      }
      case 'app.ui.act': {
        const { appInstanceId, documentGeneration, action } = input as AppToolInput<'app.ui.act'>;
        this.writable(context, appInstanceId, signal);
        await this.fresh(context, signal);
        context = await refresh();
        this.writable(context, appInstanceId, signal);
        const ui = this.ui(context, context.runId);
        generations.before = ui.identity().documentGeneration;
        const outcome = await ui.act(action, { runId: context.runId, documentGeneration }, signal);
        generations.after = outcome.documentGeneration;
        return { ...outcome, action: action.type };
      }
      case 'app.data.query': {
        const { sql, limit } = input as AppToolInput<'app.data.query'>;
        const { data, mode } = await this.agent(context, { op: 'query', sql, limit }, signal);
        return { ...data, mode };
      }
      case 'app.data.seed':
      case 'app.data.reset': {
        const { appInstanceId } = input as AppToolInput<'app.data.seed'>;
        this.writable(context, appInstanceId, signal);
        if (tool === 'app.data.reset' && !context.allowsReset)
          throw new AppControlFailure('authorization_required', '重置需要用户在任务允许范围中写明 app.data.reset');
        await this.fresh(context, signal);
        context = await refresh();
        this.writable(context, appInstanceId, signal);
        const capability = await this.revision(context, signal);
        if (capability.operationTrackingVersion !== 1) throw new AppControlFailure('unsupported', '项目不支持操作追踪协议，拒绝数据写入');
        const operation = tool === 'app.data.reset' ? 'reset' : 'seed';
        const pending: PendingOperation = {
          operationId: randomUUID(),
          workspaceId: context.workspaceId,
          projectId: context.app!.projectId,
          appInstanceId,
          runId: context.runId,
          sessionId: context.sessionId,
          generation: context.executionBinding?.generation ?? null,
          turnId: context.executionBinding?.turnId ?? null,
          kind: 'data',
          operation,
        };
        this.pending.set(pending.operationId, pending);
        await this.savePending();
        let result: AppAgentResult;
        let dispatched = false;
        this.reconciling.add(context.runId);
        try {
          context = await refresh();
          this.writable(context, appInstanceId, signal, pending.operationId);
          dispatched = true;
          result = await this.ports.agent(this.target(context), appInstanceId, { op: operation, operationId: pending.operationId }, signal);
          await this.acceptReceipt(pending, result);
        } finally {
          try {
            if (!dispatched) await this.removePending([pending.operationId]);
          } finally {
            this.reconciling.delete(context.runId);
            if (this.pending.has(pending.operationId)) this.retryAvailable.add(context.runId);
            this.ports.pendingChanged?.(context.workspaceId, context.runId);
          }
        }
        signal.throwIfAborted();
        if (!result.envelope.ok) throw new AppControlFailure('unavailable', result.envelope.error.message);
        return { ...result.envelope.data, appInstanceId, operationId: pending.operationId };
      }
      case 'app.scenario.run': {
        const { appInstanceId, scenario } = input as AppToolInput<'app.scenario.run'>;
        this.writable(context, appInstanceId, signal);
        const manifest = await this.fresh(context, signal);
        context = await refresh();
        this.writable(context, appInstanceId, signal);
        return this.scenario(context, appInstanceId, scenario, manifest, signal, generations, refresh);
      }
    }
    throw new AppControlFailure('unsupported', `未实现的工具：${String(tool)}`);
  }

  private async snapshotState(ui: AppUiPort, context: AppControlContext, signal: AbortSignal) {
    const state = await ui.bridge({ op: 'state' }, signal).then(
      (response) => (response.ok ? response.data : { error: response.error.code }),
      (error: unknown) => ({ error: error instanceof AppControlFailure ? error.code : 'unavailable' }),
    );
    let cleanupConfirmed = true;
    const database = await this.ports.agent(this.target(context), context.app!.appInstanceId, { op: 'snapshot' }, signal).then(
      (result) => {
        cleanupConfirmed = result.cleanupConfirmed;
        if (!result.envelope.ok) return { error: result.envelope.error.code };
        const tables = (result.envelope.data.tables ?? {}) as Record<string, { rowCount?: unknown; sha256?: unknown }>;
        return Object.fromEntries(
          Object.entries(tables).map(([name, table]) => [name, { rowCount: table.rowCount, sha256: table.sha256 }]),
        );
      },
      () => ({ error: 'unavailable' }),
    );
    return { snapshot: { state, db: database }, cleanupConfirmed };
  }

  /** 确定性回放：顺序执行、首个失败即停；轨迹、截图与状态 diff 追加写入证据目录。 */
  private async scenario(
    context: AppControlContext,
    appInstanceId: string,
    scenario: AppScenario,
    manifest: AppManifest,
    signal: AbortSignal,
    generations: { before: number | null; after: number | null },
    refresh: () => Promise<AppControlContext>,
  ): Promise<Record<string, unknown>> {
    const ui = this.ui(context, context.runId);
    const scenarioRunId = randomUUID();
    const startedAt = new Date().toISOString();
    const mark = ui.consoleMark();
    generations.before = ui.identity().documentGeneration;
    ui.beginControl(context.runId, `scenario:${scenario.name}`);
    const before = await this.snapshotState(ui, context, signal);
    let cleanupConfirmed = before.cleanupConfirmed;
    const steps: AppScenarioTrace['steps'] = [];
    let outcome: AppScenarioTrace['outcome'] = 'passed';
    let inFlight: AppScenarioTrace['inFlight'] = null;
    const screenshots: string[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      const summary = describeStep(step);
      if (outcome !== 'passed' && outcome !== 'cancelled') {
        steps.push({
          index,
          type: step.type,
          summary,
          outcome: 'skipped',
          error: null,
          durationMs: 0,
          documentGeneration: null,
          screenshot: null,
        });
        continue;
      }
      if (outcome === 'cancelled' || signal.aborted) {
        outcome = 'cancelled';
        steps.push({
          index,
          type: step.type,
          summary,
          outcome: 'cancelled',
          error: { code: 'cancelled', message: '场景已取消，未开始此步' },
          durationMs: 0,
          documentGeneration: null,
          screenshot: null,
        });
        continue;
      }
      const stepStarted = Date.now();
      let screenshot: AppScenarioTrace['steps'][number]['screenshot'] = null;
      try {
        context = await refresh();
        this.writable(context, appInstanceId, signal);
        if (step.type === 'act')
          await ui.act(step.action, { runId: context.runId, documentGeneration: ui.identity().documentGeneration }, signal);
        else if (step.type === 'command') {
          if (!manifest.commands.some((command) => command.name === step.name))
            throw new AppControlFailure('command_not_found', `命令 ${step.name} 未在 manifest 登记`);
          this.bridgeData(await ui.bridge({ op: 'invoke', name: step.name, input: step.input }, signal));
        } else if (step.type === 'screenshot') {
          const png = await ui.screenshot();
          const file = await this.ports.store.writeEvidence(
            context.runId,
            scenarioRunId,
            `${String(index).padStart(2, '0')}-${step.label}.png`,
            png,
          );
          screenshot = { file: path.basename(file), sha256: sha256(png) };
          screenshots.push(file);
        } else await this.assert(step.assert, ui, mark, signal);
        steps.push({
          index,
          type: step.type,
          summary,
          outcome: 'passed',
          error: null,
          durationMs: Date.now() - stepStarted,
          documentGeneration: ui.identity().documentGeneration,
          screenshot,
        });
      } catch (error) {
        const failure = this.failure(error, signal.aborted, false);
        // 行为不满足（找不到、超时、禁用、遮挡、断言不符）记 failed；通道或环境问题记 error。
        outcome =
          failure.code === 'cancelled'
            ? 'cancelled'
            : failure.code === 'paused_by_user'
              ? 'paused_by_user'
              : step.type === 'assert' || BEHAVIOURAL.has(failure.code)
                ? 'failed'
                : 'error';
        steps.push({
          index,
          type: step.type,
          summary,
          outcome: failure.code === 'cancelled' ? 'cancelled' : 'failed',
          error: failure,
          durationMs: Date.now() - stepStarted,
          documentGeneration: safeGeneration(ui),
          screenshot,
        });
      }
      // 步骤 promise 已结算：在途 CDP 指令已返回，guest 子进程由 service 关闭并回执。
      inFlight = { kind: step.type, settled: true };
    }
    // 取消后仍记录结束状态，不再发起新的页面或数据库读取以外的动作。
    const after = await this.snapshotState(ui, context, AbortSignal.timeout(5000));
    cleanupConfirmed = cleanupConfirmed && after.cleanupConfirmed;
    generations.after = safeGeneration(ui);
    const revisionCheck = await this.revision(context, AbortSignal.timeout(5000)).then(
      (value) => ({
        sourceRevision: manifest.sourceRevision,
        currentRevision: value.currentRevision,
        error:
          value.currentRevision === manifest.sourceRevision
            ? null
            : { code: 'manifest_stale', message: '场景执行期间源码已变化，本轮行为证据不能证明当前源码' },
      }),
      (error: unknown) => ({
        sourceRevision: manifest.sourceRevision,
        currentRevision: null,
        error: this.failure(error, false, false),
      }),
    );
    if (revisionCheck.error && outcome === 'passed') outcome = 'error';
    const revisionCheckRef = await this.ports.store.writeEvidence(
      context.runId,
      scenarioRunId,
      'revision-check.json',
      JSON.stringify(revisionCheck, null, 2) + '\n',
    );
    const trace = AppScenarioTraceSchema.parse({
      traceVersion: 1,
      scenarioRunId,
      scenarioName: scenario.name,
      scenarioSha256: sha256(JSON.stringify(scenario)),
      runId: context.runId,
      workspaceId: context.workspaceId,
      appInstanceId,
      sourceRevision: manifest.sourceRevision,
      startedAt,
      endedAt: new Date().toISOString(),
      outcome,
      steps,
      stateDiff: jsonDiff(before.snapshot, after.snapshot),
      inFlight: outcome === 'cancelled' ? inFlight : null,
      cleanupConfirmed,
    } satisfies AppScenarioTrace);
    const traceRef = await this.ports.store.writeEvidence(
      context.runId,
      scenarioRunId,
      'trace.json',
      JSON.stringify(trace, null, 2) + '\n',
    );
    return { scenarioRunId, outcome, trace, evidence: { trace: traceRef, screenshots, revisionCheck: revisionCheckRef }, note: RULES[2] };
  }

  private async assert(
    assertion: Extract<AppScenario['steps'][number], { type: 'assert' }>['assert'],
    ui: AppUiPort,
    mark: number,
    signal: AbortSignal,
  ) {
    if (assertion.kind === 'console-no-error') {
      const errors = ui.consoleErrorsSince(mark);
      if (errors.length)
        throw new AppControlFailure('command_failed', `场景期间出现 ${errors.length} 个 console 错误/异常`, { errors: errors.slice(0, 5) });
      return;
    }
    if (assertion.kind === 'state') {
      const states = this.bridgeData(await ui.bridge({ op: 'state', names: [assertion.name] }, signal)) as Record<string, unknown>;
      const actual = pointer(states[assertion.name], assertion.path);
      if (!isDeepStrictEqual(actual, assertion.equals))
        throw new AppControlFailure('command_failed', `状态 ${assertion.name}${assertion.path} 不等于期望值`, { actual: actual ?? null });
      return;
    }
    // 文本/元素断言按 timeoutMs 轮询（默认 0 即立即判定），最后一次结果决定成败。
    const deadline = Date.now() + assertion.timeoutMs;
    for (;;) {
      try {
        return await this.assertElement(assertion, ui, signal);
      } catch (error) {
        if (Date.now() >= deadline || !(error instanceof AppControlFailure) || signal.aborted) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async assertElement(
    assertion: Extract<Extract<AppScenario['steps'][number], { type: 'assert' }>['assert'], { kind: 'text' | 'testid' }>,
    ui: AppUiPort,
    signal: AbortSignal,
  ) {
    const found = await ui.query({ testid: assertion.testid }, signal);
    if (assertion.kind === 'text') {
      if (found.count !== 1)
        throw new AppControlFailure('element_not_found', `data-testid="${assertion.testid}" 匹配 ${found.count} 个元素`);
      const text = found.text ?? '';
      const ok = assertion.equals !== undefined ? text === assertion.equals : text.includes(assertion.contains!);
      if (!ok) throw new AppControlFailure('command_failed', `文本断言失败`, { actual: text.slice(0, 500) });
      return;
    }
    const ok =
      assertion.state === 'attached'
        ? found.count === 1
        : assertion.state === 'detached'
          ? found.count === 0
          : assertion.state === 'visible'
            ? found.count === 1 && found.visible
            : assertion.state === 'hidden'
              ? found.count === 0 || !found.visible
              : assertion.state === 'enabled'
                ? found.count === 1 && found.enabled
                : found.count === 1 && !found.enabled;
    if (!ok)
      throw new AppControlFailure(
        found.count === 0 ? 'element_not_found' : 'command_failed',
        `data-testid="${assertion.testid}" 不满足 ${assertion.state}`,
      );
  }
}

function safeGeneration(ui: AppUiPort): number | null {
  try {
    return ui.identity().documentGeneration;
  } catch {
    return null;
  }
}

function describeStep(step: AppScenario['steps'][number]): string {
  const target = (selector?: AppTargetSelector) =>
    selector ? ('testid' in selector ? `testid=${selector.testid}` : `ref=${selector.ref}`) : '';
  switch (step.type) {
    case 'act': {
      const action = step.action;
      const detail =
        action.type === 'navigate'
          ? action.path
          : action.type === 'press'
            ? `${action.key} ${target(action.target)}`
            : action.type === 'type'
              ? `${target(action.target)} len=${action.text.length}`
              : action.type === 'waitFor'
                ? `${target(action.target)} ${action.state}`
                : action.type === 'scroll'
                  ? target(action.target) || `${action.direction} ${action.amount ?? 400}`
                  : target(action.target);
      return `act ${action.type} ${detail}`.trim();
    }
    case 'command':
      return `command ${step.name}`;
    case 'screenshot':
      return `screenshot ${step.label}`;
    case 'assert': {
      const assertion = step.assert;
      return assertion.kind === 'console-no-error'
        ? 'assert console-no-error'
        : assertion.kind === 'state'
          ? `assert state ${assertion.name}${assertion.path}`
          : assertion.kind === 'text'
            ? `assert text testid=${assertion.testid} ${assertion.equals !== undefined ? 'equals' : 'contains'}`
            : `assert testid=${assertion.testid} ${assertion.state}`;
    }
  }
}

/** Main 用户数据目录下的追加审计与排他创建的场景证据；runId/scenarioRunId 由 Main 生成。 */
export class FileAppControlStore implements AppControlStore {
  constructor(private readonly root: string) {}
  async loadPending(): Promise<PendingOperation[]> {
    try {
      const data: unknown = JSON.parse(await readFile(path.join(this.root, 'pending.json'), 'utf8'));
      return z
        .object({ version: z.literal(1), operations: z.array(PendingOperationSchema) })
        .strict()
        .parse(data).operations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; // Older stores contain only immutable audit/scenario evidence.
      throw error;
    }
  }
  async savePending(operations: PendingOperation[]) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, `pending-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, operations }), { mode: 0o600 });
    await rename(temporary, path.join(this.root, 'pending.json'));
  }
  private directory(runId: string) {
    if (!/^[A-Za-z0-9-]{1,200}$/.test(runId)) throw new Error('无效的 runId');
    return path.join(this.root, runId);
  }
  async appendAudit(record: AppAuditRecord) {
    const directory = this.directory(record.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(path.join(directory, 'audit.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  async writeEvidence(runId: string, scenarioRunId: string, name: string, data: string | Buffer) {
    if (!/^[0-9a-f-]{36}$/.test(scenarioRunId) || !/^[A-Za-z0-9_.-]{1,120}$/.test(name) || name.startsWith('.'))
      throw new Error('无效的证据名');
    const directory = path.join(this.directory(runId), 'scenarios', scenarioRunId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, name);
    await writeFile(file, data, { flag: 'wx', mode: 0o600 });
    return path.relative(path.dirname(this.root), file);
  }
}
