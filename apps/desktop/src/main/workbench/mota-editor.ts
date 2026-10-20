import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MotaEditorBindingSchema,
  MotaEditorOperationSchema,
  MotaEditorResultSchema,
  MotaEditorReadDataSchema,
  MotaEditorRequestSchema,
  MotaEditorReadInputSchema,
  MotaEditorSaveInputSchema,
  MotaEditorCloseInputSchema,
  MotaEditorStatusInputSchema,
  type MotaEditorBinding,
  type MotaEditorReadInput,
  type MotaEditorSaveInput,
  type MotaEditorCloseInput,
  type MotaEditorStatusInput,
  type MotaEditorProjection,
  type MotaEditorReadResult,
  type MotaEditorRequest,
} from '@wsl/protocol';
import type { MotaEditorNativePort, MotaEditorServicePort } from './ports';
import type { EditorOperationRecord, MotaEditorOperationStore } from './mota-editor-repository';

export const MOTA_EDITOR_URL = 'wsl-editor://mota/index.html';
export type MotaEditorFacts = {
  workspaceId: string;
  projectId: string;
  appInstanceId: string;
  resourceId: string;
  resourceInstanceId: string;
  resourceGeneration: number;
  browserInstanceId: string;
  browserGeneration: number;
  webContentsId: number;
  processId: number;
  routingId: number;
  documentGeneration: number;
  navigationEpoch: number;
  url: string;
  assetVersion: string;
  manifestDigest: string;
  trusted: boolean;
  visible: boolean;
  destroyed: boolean;
  theme: MotaEditorProjection['theme'];
};
type EditorSession = {
  index: number;
  id: string;
  binding: MotaEditorBinding;
  facts: MotaEditorFacts;
  state: 'opening' | 'active' | 'revoked';
  settled: boolean;
  revocationConfirmed: boolean;
  busy: boolean;
  error: string | null;
  baselines: Map<string, string | null>;
  opening?: Promise<void>;
  revoking?: Promise<void>;
};
type EditorPorts = MotaEditorNativePort & MotaEditorServicePort;
type Scope = (facts: MotaEditorFacts) => boolean;
const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : '编辑器操作失败');
const key = (sessionId: string, requestId: string) => sessionId + ':' + requestId;

/** Grants live here, never in Host, preload, a session index or a fresh document. */
export class MotaEditorAuthority {
  private readonly sessions = new Map<number, EditorSession>();
  private readonly records = new Map<string, EditorOperationRecord>();
  private readonly epochs = new Map<string, number>();
  private nextIndex = 0;
  private readonly requestedReopens = new Set<string>();
  private persistence: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  constructor(
    private readonly ports: EditorPorts,
    private readonly store: MotaEditorOperationStore,
    private readonly scope: Scope,
  ) {
    this.ready = store.load().then((records) => {
      for (const record of records) {
        this.records.set(key(record.editorSessionId, record.operation.requestId), record);
        this.nextIndex = Math.max(this.nextIndex, record.sessionIndex);
        this.epochs.set(
          record.binding.appInstanceId,
          Math.max(this.epochs.get(record.binding.appInstanceId) ?? 0, record.binding.editorEpoch),
        );
      }
    });
    // Admission awaits the same rejection; avoid an unhandled startup promise.
    void this.ready.catch((error: unknown) => console.error('编辑器操作记录加载失败', error));
  }
  private currentFacts(resourceId: string) {
    return this.ports.motaEditorFacts(resourceId);
  }
  private valid(facts: MotaEditorFacts): boolean {
    return (
      !facts.destroyed &&
      facts.trusted &&
      facts.visible &&
      facts.url === MOTA_EDITOR_URL &&
      /^[a-f0-9]{64}$/.test(facts.manifestDigest) &&
      /^[a-f0-9]{64}$/.test(facts.assetVersion) &&
      this.scope(facts)
    );
  }
  private active(session: EditorSession) {
    const facts = this.currentFacts(session.facts.resourceId);
    if (session.state !== 'active' || !facts || !this.valid(facts) || !isDeepStrictEqual(facts, session.facts))
      throw new Error('revoked: 编辑器授权已失效，请重新读取');
  }
  private session(index: number, resourceId: string): EditorSession {
    const session = this.sessions.get(index);
    if (!session || session.facts.resourceId !== resourceId) throw new Error('revoked: 编辑器会话已失效');
    return session;
  }
  projection(resourceId: string): MotaEditorProjection {
    const session = [...this.sessions.values()].findLast((session) => session.facts.resourceId === resourceId);
    return {
      sessionIndex: session?.index ?? null,
      state: session?.state ?? 'revoked',
      theme: this.currentFacts(resourceId)?.theme ?? 'system',
      error: session?.error ?? null,
      operations: [...this.records.values()]
        .filter((record) => record.binding.resourceId === resourceId)
        .map((record) => ({
          sessionIndex: record.sessionIndex,
          operation: structuredClone(record.operation),
          durabilityIssue: record.durabilityIssue,
        })),
    };
  }
  private publish(resourceId: string) {
    const facts = this.currentFacts(resourceId);
    if (facts && !facts.destroyed) {
      try {
        this.ports.motaEditorVisibility(resourceId, facts.visible, this.projection(resourceId));
      } catch {
        for (const session of this.sessions.values())
          if (session.facts.resourceId === resourceId) session.error = '编辑器状态通知失败；请核对原操作';
        for (const record of this.records.values())
          if (record.binding.resourceId === resourceId) record.durabilityIssue = '编辑器状态通知失败；原操作仍可查询';
      }
    }
  }
  factsChanged(facts: MotaEditorFacts): void {
    for (const session of this.sessions.values())
      if (
        session.facts.resourceId === facts.resourceId &&
        session.state !== 'revoked' &&
        (!this.valid(facts) || !isDeepStrictEqual(session.facts, facts))
      )
        this.revoke(session);
    if (
      this.valid(facts) &&
      [...this.sessions.values()].some(
        (session) => session.facts.resourceId === facts.resourceId && session.state === 'revoked' && !session.settled,
      )
    )
      this.requestedReopens.add(facts.resourceId);
    if (this.valid(facts))
      void this.openMotaEditor(facts).catch((error: unknown) => {
        const session = [...this.sessions.values()].findLast((entry) => entry.facts.resourceId === facts.resourceId);
        if (session) session.error = errorText(error);
        this.publish(facts.resourceId);
      });
  }
  async openMotaEditor(facts: MotaEditorFacts): Promise<void> {
    await this.ready;
    const current = this.currentFacts(facts.resourceId);
    if (!current || !isDeepStrictEqual(current, facts) || !this.valid(current)) return;
    if ([...this.sessions.values()].some((session) => session.facts.resourceId === facts.resourceId && session.state !== 'revoked')) return;
    const unsettled = new Set([...this.sessions.values()].filter((session) => !session.settled).map((session) => session.id));
    for (const record of this.records.values()) if (record.phase === 'unknown') unsettled.add(record.editorSessionId);
    if (
      unsettled.size >= 16 ||
      [...this.sessions.values()].some((session) => session.binding.appInstanceId === facts.appInstanceId && !session.settled) ||
      [...this.records.values()].some((record) => record.binding.appInstanceId === facts.appInstanceId && record.phase === 'unknown')
    )
      throw new Error('busy: 原编辑器操作尚未结清');
    const epoch = (this.epochs.get(facts.appInstanceId) ?? 0) + 1;
    this.epochs.set(facts.appInstanceId, epoch);
    const binding = MotaEditorBindingSchema.parse({
      workspaceId: facts.workspaceId,
      environmentId: 'sandbox',
      projectId: facts.projectId,
      appInstanceId: facts.appInstanceId,
      resourceId: facts.resourceId,
      resourceInstanceId: facts.resourceInstanceId,
      resourceGeneration: facts.resourceGeneration,
      browserInstanceId: facts.browserInstanceId,
      browserGeneration: facts.browserGeneration,
      documentGeneration: facts.documentGeneration,
      editorEpoch: epoch,
    });
    const session: EditorSession = {
      index: ++this.nextIndex,
      id: randomUUID(),
      binding,
      facts: structuredClone(facts),
      state: 'opening',
      settled: false,
      revocationConfirmed: false,
      busy: false,
      error: null,
      baselines: new Map(),
    };
    this.sessions.set(session.index, session);
    this.publish(facts.resourceId);
    session.opening = this.call(session, { method: 'editor.open', input: {} }, false).then(
      () => {
        const latest = this.currentFacts(facts.resourceId);
        if (session.state === 'opening' && latest && this.valid(latest) && isDeepStrictEqual(session.facts, latest))
          session.state = 'active';
        else this.revoke(session);
      },
      (error: unknown) => {
        session.error = errorText(error);
        this.revoke(session);
      },
    );
    await session.opening;
    this.publish(facts.resourceId);
  }
  private async call(
    session: EditorSession,
    action: Pick<MotaEditorRequest, 'method' | 'input'>,
    requireActive: boolean,
    requestId: string = randomUUID(),
  ) {
    if (requireActive) this.active(session);
    const request = MotaEditorRequestSchema.parse({ binding: session.binding, editorSessionId: session.id, requestId, ...action });
    const reply = MotaEditorResultSchema.parse(await this.ports.motaEditorRequest(request));
    if (
      reply.editorSessionId !== session.id ||
      reply.requestId !== requestId ||
      reply.method !== action.method ||
      !isDeepStrictEqual(reply.binding, session.binding)
    )
      throw new Error('unknown: 编辑器回执归属不匹配');
    if (!reply.ok) throw new Error((reply.error?.code ?? 'unknown') + ': ' + (reply.error?.message ?? '操作未确认'));
    return reply.data!;
  }
  revokeResource(resourceId: string): void {
    for (const session of this.sessions.values()) if (session.facts.resourceId === resourceId) this.revoke(session);
  }
  revokeAll(): void {
    for (const session of this.sessions.values()) this.revoke(session);
  }
  private revoke(session: EditorSession): void {
    session.state = 'revoked';
    session.baselines.clear();
    if (session.revoking || session.settled) return;
    this.publish(session.facts.resourceId);
    session.revoking = (async () => {
      if (session.opening) await session.opening;
      const data = await this.call(session, { method: 'editor.revoke', input: {} }, false);
      if (!('settled' in data) || !data.settled) throw new Error('unknown: 撤销尚未确认');
      if (data.operation) this.settleOriginal(session, data.operation);
      session.revocationConfirmed = true;
      // An ACK is not proof that every original operation has a terminal receipt.
      session.settled = ![...this.records.values()].some(
        (record) => record.editorSessionId === session.id && !['committed', 'failed'].includes(record.phase),
      );
      try {
        await this.persist();
      } catch {
        for (const record of this.records.values())
          if (record.editorSessionId === session.id) record.durabilityIssue = '撤销结算结果持久化失败';
      }
      this.publish(session.facts.resourceId);
      const current = this.currentFacts(session.facts.resourceId);
      if (session.settled && this.requestedReopens.delete(session.facts.resourceId) && current && this.valid(current))
        this.factsChanged(current);
    })().catch((error: unknown) => {
      session.error = errorText(error);
      this.publish(session.facts.resourceId);
    });
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone([...this.records.values()]);
    const next = this.persistence.then(() => this.store.save(snapshot));
    this.persistence = next.catch(() => undefined);
    return next;
  }
  async readMotaEditorFile(resourceId: string, input: MotaEditorReadInput): Promise<MotaEditorReadResult> {
    const request = MotaEditorReadInputSchema.parse(input);
    await this.ready;
    const session = this.session(request.sessionIndex, resourceId);
    this.active(session);
    if (session.busy) throw new Error('busy: 编辑器操作正在进行');
    session.busy = true;
    try {
      const data = MotaEditorReadDataSchema.parse(
        await this.call(session, { method: 'editor.read', input: { file: request.file } }, true, request.requestId),
      );
      this.active(session);
      const bytes = Buffer.from(data.content ?? '', 'utf8');
      if (
        bytes.length !== data.contentLength ||
        (data.content === null ? data.contentHash !== null : createHash('sha256').update(bytes).digest('hex') !== data.contentHash)
      )
        throw new Error('unknown: 读取内容校验失败');
      session.baselines.set(request.file, data.contentHash);
      return { sessionIndex: session.index, ...data };
    } finally {
      session.busy = false;
    }
  }
  async saveMotaEditorFile(resourceId: string, input: MotaEditorSaveInput): Promise<MotaEditorProjection['operations'][number]> {
    const request = MotaEditorSaveInputSchema.parse(input);
    await this.ready;
    const session = this.session(request.sessionIndex, resourceId);
    const bytes = Buffer.from(request.content, 'utf8');
    if (bytes.length > 262144) throw new Error('invalid_content: 文件超过 256 KiB');
    const metadata = {
      file: request.file,
      expectedHash: request.expectedHash,
      contentLength: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
    const prior = this.records.get(key(session.id, request.requestId));
    if (prior) {
      if (!isDeepStrictEqual(prior.metadata, metadata)) throw new Error('operation_conflict: 同一保存身份不能更换内容');
      return this.operationView(prior);
    }
    this.active(session);
    if (session.busy) throw new Error('busy: 编辑器操作正在进行');
    if (!session.baselines.has(request.file) || session.baselines.get(request.file) !== request.expectedHash)
      throw new Error('source_changed: 请先核对当前内容，保留草稿');
    if (
      this.records.size >= 4096 ||
      [...this.records.values()].filter((record) => record.binding.appInstanceId === session.binding.appInstanceId).length >= 1024
    )
      throw new Error('budget_exceeded: 保存记录已达上限');
    const record: EditorOperationRecord = {
      binding: session.binding,
      editorSessionId: session.id,
      sessionIndex: session.index,
      metadata,
      phase: 'staging',
      operation: { requestId: request.requestId, status: 'staging', receipt: null, error: null },
      durabilityIssue: null,
    };
    this.records.set(key(session.id, request.requestId), record);
    session.busy = true;
    let submitted = false;
    try {
      const staged = MotaEditorOperationSchema.parse(
        await this.call(session, { method: 'editor.stage', input: { ...metadata, content: request.content } }, true, request.requestId),
      );
      if (staged.requestId !== request.requestId) throw new Error('unknown: 暂存指向另一操作');
      if (staged.status !== 'staged') throw new Error('unknown: 暂存未确认');
      this.active(session);
      record.phase = 'submitted';
      // A durable intent precedes the only dispatch that may rename the target.
      await this.persist();
      this.active(session);
      submitted = true;
      const operation = MotaEditorOperationSchema.parse(
        await this.call(session, { method: 'editor.commit', input: metadata }, true, request.requestId),
      );
      if (operation.requestId !== request.requestId) throw new Error('unknown: 提交指向另一操作');
      this.settleOriginal(session, operation);
      if (operation.status === 'committed' && session.state === 'active') session.baselines.set(request.file, operation.receipt!.afterHash);
    } catch (error) {
      if (record.phase !== 'committed' && record.phase !== 'failed') {
        record.phase = submitted ? 'unknown' : 'failed';
        record.operation = {
          requestId: request.requestId,
          status: submitted ? 'unknown' : 'failed',
          receipt: null,
          error: errorText(error),
        };
      }
      this.revoke(session);
    } finally {
      session.busy = false;
      try {
        await this.persist();
      } catch {
        record.durabilityIssue = '操作结果未能持久保存；请保留本窗口并核对原操作';
      }
      this.publish(resourceId);
      if (session.state === 'revoked' && session.revocationConfirmed) {
        session.settled = ![...this.records.values()].some(
          (entry) => entry.editorSessionId === session.id && !['committed', 'failed'].includes(entry.phase),
        );
        const current = this.currentFacts(resourceId);
        if (session.settled && this.requestedReopens.delete(resourceId) && current && this.valid(current)) this.factsChanged(current);
      }
    }
    return this.operationView(record);
  }
  private operationView(record: EditorOperationRecord) {
    return { sessionIndex: record.sessionIndex, operation: structuredClone(record.operation), durabilityIssue: record.durabilityIssue };
  }
  private settleOriginal(session: Pick<EditorSession, 'id'>, input: unknown) {
    const operation = MotaEditorOperationSchema.parse(input);
    const record = this.records.get(key(session.id, operation.requestId));
    if (!record) throw new Error('unknown: 无法匹配原保存记录');
    if (record.phase === 'committed') {
      if (!isDeepStrictEqual(record.operation, operation)) throw new Error('unknown: 已提交回执发生变化');
      return;
    }
    if (record.phase === 'failed') {
      // A local pre-dispatch error may include presentation context absent from
      // the guest error code. Both prove failure; keep the first returned result.
      if (operation.status !== 'failed') throw new Error('unknown: 失败操作的结算状态不一致');
      return;
    }
    if (
      operation.receipt &&
      (!isDeepStrictEqual(record.metadata, {
        file: operation.receipt.file,
        expectedHash: operation.receipt.expectedHash,
        contentLength: operation.receipt.contentLength,
        contentHash: operation.receipt.contentHash,
      }) ||
        operation.receipt.editorSessionId !== record.editorSessionId ||
        operation.receipt.afterHash !== record.metadata.contentHash)
    )
      throw new Error('unknown: 保存回执内容不匹配');
    if (operation.status === 'committed' || operation.status === 'failed') {
      record.operation = operation;
      record.phase = operation.status;
    } else {
      record.phase = 'unknown';
      record.operation = { requestId: operation.requestId, status: 'unknown', receipt: null, error: '原操作尚未确认' };
    }
  }
  async closeMotaEditor(resourceId: string, input: MotaEditorCloseInput): Promise<void> {
    const request = MotaEditorCloseInputSchema.parse(input);
    const session = this.session(request.sessionIndex, resourceId);
    this.revoke(session);
    this.ports.releaseMotaEditor(resourceId);
  }
  async motaEditorOperationStatus(resourceId: string, input: MotaEditorStatusInput): Promise<MotaEditorProjection> {
    const request = MotaEditorStatusInputSchema.parse(input);
    await this.ready;
    if (request.operationRequestId) {
      const record = [...this.records.values()].find(
        (entry) =>
          entry.binding.resourceId === resourceId &&
          entry.sessionIndex === request.sessionIndex &&
          entry.operation.requestId === request.operationRequestId,
      );
      if (!record) throw new Error('unknown: 找不到原保存记录');
      if (!['committed', 'failed'].includes(record.phase)) {
        // Reconcile only the original immutable binding. A hash read never proves rename.
        const data = MotaEditorResultSchema.parse(
          await this.ports.motaEditorRequest({
            binding: record.binding,
            editorSessionId: record.editorSessionId,
            requestId: request.requestId,
            method: 'editor.status',
            input: { operationRequestId: record.operation.requestId },
          }),
        );
        if (
          !isDeepStrictEqual(data.binding, record.binding) ||
          data.editorSessionId !== record.editorSessionId ||
          data.requestId !== request.requestId ||
          data.method !== 'editor.status'
        )
          throw new Error('unknown: 状态回执归属不匹配');
        if (data.ok) {
          const operation = MotaEditorOperationSchema.parse(data.data);
          if (operation.requestId !== record.operation.requestId) throw new Error('unknown: 状态指向另一操作');
          this.settleOriginal({ id: record.editorSessionId }, operation);
          const session = this.sessions.get(record.sessionIndex);
          if (session?.state === 'revoked' && session.revocationConfirmed) {
            session.settled = ![...this.records.values()].some(
              (entry) => entry.editorSessionId === session.id && !['committed', 'failed'].includes(entry.phase),
            );
          }
        }
        try {
          await this.persist();
        } catch {
          record.durabilityIssue = '原操作结果持久化失败';
        }
      }
    }
    const current = this.currentFacts(resourceId);
    if (current && this.valid(current) && !request.operationRequestId) await this.openMotaEditor(current);
    return this.projection(resourceId);
  }
}
