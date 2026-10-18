import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ResearchCaptureSchema,
  ResearchReplySchema,
  PageResourceSnapshotSchema,
  type ResearchCall,
  type ResearchReply,
  type ResourceInstanceIdentity,
  type WorkbenchResource,
  type WorkbenchRun,
  type WorkspaceSnapshot,
} from '@wsl/protocol';
import type { BrowserPort } from './ports';
import { type ResearchOwners, ResearchFailure, assertResearchBudget, assertResearchCapture, captureSummary } from './research';

type ResearchHost = {
  serialize<T>(work: () => T | Promise<T>): Promise<T>;
  persist(workspace: WorkspaceSnapshot, entityId: string): Promise<void>;
  requireWorkspace(workspaceId: string): WorkspaceSnapshot;
  run(workspace: WorkspaceSnapshot, runId: string): WorkbenchRun;
  session(workspace: WorkspaceSnapshot, sessionId: string): WorkspaceSnapshot['sessions'][number];
  resource(workspace: WorkspaceSnapshot, resourceId: string, kind?: string): WorkbenchResource;
  instance(workspace: WorkspaceSnapshot, resource: WorkbenchResource): ResourceInstanceIdentity;
  readonly activeWorkspaceId: string;
  executionBinding(run: WorkbenchRun): { generation: string; turnId: string | null } | null | undefined;
  readonly accountId: string;
  readonly closing: boolean;
  readonly ready: Promise<void>;
  createResource(
    workspace: WorkspaceSnapshot,
    kind: WorkbenchResource['kind'],
    title: string,
    url?: string,
    environmentId?: WorkbenchResource['environmentId'],
  ): Pick<WorkspaceSnapshot['tabs'][number], 'targetRef'>;
  openResource(workspace: WorkspaceSnapshot, resourceId: string): void;
  ensureBrowser(workspace: WorkspaceSnapshot, resource: WorkbenchResource, options?: { deferInitialLoad: boolean }): void;
  runtime: Pick<BrowserPort, 'validateBrowserUrl' | 'browserState' | 'openResearchDocument'>;
  observationCounts: Map<string, number>;
  researchOwners: ResearchOwners;
};

/** Internal research operations share the application queue, budget, and live owners. */
export class ResearchUseCase {
  constructor(private readonly host: ResearchHost) {}
  failure(call: ResearchCall, error: unknown, signal?: AbortSignal): ResearchReply {
    const code = signal?.aborted ? 'cancelled' : error instanceof ResearchFailure ? error.code : 'unavailable';
    const message = signal?.aborted ? '本轮研究操作已取消' : error instanceof Error ? error.message : '公开研究不可用';
    return ResearchReplySchema.parse({
      callId: call.callId,
      context: call.context,
      result: { ok: false, tool: call.tool, error: { code, message: message.slice(0, 1000) || '公开研究失败' } },
    });
  }
  private context(call: ResearchCall, signal: AbortSignal) {
    if (this.host.closing || signal.aborted) throw new ResearchFailure('cancelled', '本轮研究已停止');
    const owner = this.host.researchOwners.get(call.context);
    const w = this.host.requireWorkspace(owner.grant.workspaceId);
    const run = this.host.run(w, owner.grant.runId);
    const version = this.host.session(w, run.sessionId).taskVersions.find((item) => item.taskVersionId === run.taskVersionId);
    const binding = this.host.executionBinding(run);
    if (
      !run.research ||
      !isDeepStrictEqual(run.research.grant, owner.grant) ||
      owner.grant.accountId !== this.host.accountId ||
      owner.grant.sessionId !== run.sessionId ||
      owner.grant.taskVersionId !== run.taskVersionId ||
      !version?.appTarget ||
      w.managedApp?.projectId !== version.appTarget.projectId ||
      (w.managedApp.profile?.projectKind ?? 'standard-app') !== 'standard-app' ||
      !['starting', 'running'].includes(run.state) ||
      !binding ||
      binding.generation !== call.context.generation ||
      binding.turnId !== call.context.turnId
    )
      throw new ResearchFailure('unauthorized', '研究调用不属于当前标准 App 执行轮次');
    return { owner, w, run, state: run.research };
  }
  async perform(call: ResearchCall, signal: AbortSignal): Promise<ResearchReply> {
    await this.host.ready;
    const opening = call.tool === 'research.open';
    let reserved = false;
    try {
      const prepared = await this.host.serialize(async () => {
        const { owner, w, run, state } = this.context(call, signal);
        const count = this.host.observationCounts.get(run.runId) ?? 0;
        if (count >= 64) throw new ResearchFailure('budget_exceeded', '本轮观察与研究调用预算已用尽');
        this.host.observationCounts.set(run.runId, count + 1);
        if (call.tool === 'research.include') {
          const capture = state.captures.find((item) => item.captureId === call.args.captureId);
          if (!capture || capture.contentSha256 !== call.args.contentSha256)
            throw new ResearchFailure('invalid_request', '来源不属于本轮或正文版本不匹配');
          assertResearchCapture(capture);
          let inclusion = state.inclusions.find((item) => item.captureId === capture.captureId);
          if (!inclusion) {
            inclusion = { captureId: capture.captureId, contentSha256: capture.contentSha256, includedAt: new Date().toISOString() };
            state.inclusions.push(inclusion);
            try {
              assertResearchBudget(state, run.referenceSnapshot);
              await this.host.persist(w, call.callId);
            } catch (error) {
              state.inclusions = state.inclusions.filter((item) => item !== inclusion);
              if (error instanceof ResearchFailure) throw error;
              throw new ResearchFailure('storage_failed', '来源纳入保存失败：' + (error as Error).message);
            }
          }
          this.context(call, signal);
          return {
            reply: ResearchReplySchema.parse({
              callId: call.callId,
              context: call.context,
              result: {
                ok: true,
                tool: 'research.include',
                source: { ...captureSummary(capture), includedAt: inclusion.includedAt, text: capture.text },
              },
            }),
          };
        }
        if (!this.host.runtime.openResearchDocument) throw new ResearchFailure('unavailable', '公开研究 reader 尚未接入');
        if (owner.opening) throw new ResearchFailure('unavailable', '本轮研究网页正在加载，请等待当前读取完成');
        assertResearchBudget(state, run.referenceSnapshot, 1);
        try {
          this.host.runtime.validateBrowserUrl(call.args.url);
        } catch (error) {
          throw new ResearchFailure('blocked', (error as Error).message);
        }
        if (this.host.activeWorkspaceId !== w.workspaceId) throw new ResearchFailure('stale', '请先显示本轮所属空间');
        owner.opening = true;
        reserved = true;
        let resource = owner.readerResourceId ? w.resources.find((item) => item.resourceId === owner.readerResourceId) : undefined;
        if (!resource) {
          const tab = this.host.createResource(w, 'web', '公开研究', call.args.url, 'local');
          resource = this.host.resource(w, tab.targetRef.resourceId, 'web');
          owner.readerResourceId = resource.resourceId;
        }
        if (resource.appProjectId) throw new ResearchFailure('unauthorized', '研究 reader 不能复用 App 目标');
        this.host.ensureBrowser(w, resource, { deferInitialLoad: true });
        this.host.openResource(w, resource.resourceId);
        try {
          await this.host.persist(w, call.callId);
        } catch (error) {
          throw new ResearchFailure('storage_failed', '研究 reader 保存失败：' + (error as Error).message);
        }
        this.context(call, signal);
        const identity = this.host.instance(w, resource);
        return { identity, capture: this.host.runtime.openResearchDocument(resource.resourceId, call.args.url, signal) };
      });
      if (prepared.reply) return prepared.reply;
      let snapshot;
      try {
        snapshot = PageResourceSnapshotSchema.parse(await prepared.capture);
      } catch (error) {
        if (signal.aborted) throw new ResearchFailure('cancelled', '公开正文读取已取消');
        const code = (error as { code?: unknown } | null)?.code;
        throw new ResearchFailure(
          code === 'timeout' || code === 'stale' || code === 'cancelled' || code === 'unavailable' ? code : 'blocked',
          error instanceof Error ? error.message : '公开正文未能读取',
        );
      }
      return await this.host.serialize(async () => {
        const { w, run, state } = this.context(call, signal);
        const resource = this.host.resource(w, prepared.identity.resourceId, 'web');
        if (
          !isDeepStrictEqual(this.host.instance(w, resource), prepared.identity) ||
          !isDeepStrictEqual(this.host.runtime.browserState(resource.resourceId).page, snapshot.page)
        )
          throw new ResearchFailure('stale', '研究网页实例或文档已变化');
        const capture = ResearchCaptureSchema.parse({
          ...snapshot,
          captureId: randomUUID(),
          readerResourceId: resource.resourceId,
          textBytes: Buffer.byteLength(snapshot.text, 'utf8'),
        });
        assertResearchCapture(capture);
        state.captures.push(capture);
        try {
          assertResearchBudget(state, run.referenceSnapshot);
          await this.host.persist(w, call.callId);
        } catch (error) {
          state.captures = state.captures.filter((item) => item !== capture);
          if (error instanceof ResearchFailure) throw error;
          throw new ResearchFailure('storage_failed', '公开正文保存失败：' + (error as Error).message);
        }
        this.context(call, signal);
        return ResearchReplySchema.parse({
          callId: call.callId,
          context: call.context,
          result: { ok: true, tool: 'research.open', capture: captureSummary(capture) },
        });
      });
    } finally {
      if (opening && reserved) {
        // The owner can be revoked while awaiting I/O; clearing this slot never restores permission.
        try {
          this.host.researchOwners.get(call.context).opening = false;
        } catch {
          /* revoked owner will be discarded after drain */
        }
      }
    }
  }
}
