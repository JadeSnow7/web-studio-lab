import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CatalogReferenceSnapshot, ResearchCapture, ResearchGrant, ResearchRunState, ResearchTurnContext } from '@wsl/protocol';

export class ResearchFailure extends Error {
  constructor(
    readonly code:
      | 'unauthorized'
      | 'invalid_request'
      | 'cancelled'
      | 'timeout'
      | 'stale'
      | 'blocked'
      | 'budget_exceeded'
      | 'storage_failed'
      | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export type ResearchOwner = {
  grant: ResearchGrant;
  controller: AbortController;
  pending: number;
  opening: boolean;
  readerResourceId?: string;
};

/** Live permission exists only in this Main instance; persisted grants are history. */
export class ResearchOwners {
  private readonly owners = new Map<string, ResearchOwner>();
  register(grant: ResearchGrant): void {
    if (this.owners.has(grant.runId)) throw new ResearchFailure('unauthorized', '研究运行身份已使用');
    this.owners.set(grant.runId, { grant: structuredClone(grant), controller: new AbortController(), pending: 0, opening: false });
  }
  get(context: ResearchTurnContext): ResearchOwner {
    const owner = this.owners.get(context.grant.runId);
    if (!owner || !isDeepStrictEqual(owner.grant, context.grant)) throw new ResearchFailure('unauthorized', '本轮没有匹配的公开研究授权');
    if (owner.controller.signal.aborted) throw new ResearchFailure('cancelled', '本轮公开研究已撤销');
    return owner;
  }
  revoke(runId: string, workspaceId?: string): void {
    const owner = this.owners.get(runId);
    if (owner && (!workspaceId || owner.grant.workspaceId === workspaceId)) owner.controller.abort();
  }
  revokeAll(): void {
    for (const owner of this.owners.values()) owner.controller.abort();
  }
  hasPending(runId: string): boolean {
    return (this.owners.get(runId)?.pending ?? 0) > 0;
  }
  forget(runId: string): void {
    const owner = this.owners.get(runId);
    if (owner && !owner.pending) this.owners.delete(runId);
  }
}

export function captureSummary(capture: ResearchCapture) {
  const { text: _text, page: _page, ...summary } = capture;
  return summary;
}

export function assertResearchCapture(capture: ResearchCapture): void {
  if (
    Buffer.byteLength(capture.text, 'utf8') !== capture.textBytes ||
    capture.textBytes > 65536 ||
    createHash('sha256').update(capture.text, 'utf8').digest('hex') !== capture.contentSha256 ||
    capture.page.url !== capture.url ||
    capture.page.title !== capture.title
  )
    throw new ResearchFailure('invalid_request', '公开正文摘要、长度或页面身份不一致');
}

export function assertResearchBudget(state: ResearchRunState, references?: CatalogReferenceSnapshot, reserved = 0): void {
  if (
    (references?.resources.length ?? 0) + state.captures.length + reserved > 16 ||
    Buffer.byteLength(JSON.stringify({ references: references ?? null, research: state }), 'utf8') > 512 * 1024
  )
    throw new ResearchFailure('budget_exceeded', '本轮公开资料超过 16 条或 512 KiB 预算');
}

export function assertResearchHistory(state: ResearchRunState, references?: CatalogReferenceSnapshot): void {
  assertResearchBudget(state, references);
  const captures = new Map<string, ResearchCapture>();
  for (const capture of state.captures) {
    assertResearchCapture(capture);
    if (captures.has(capture.captureId)) throw new ResearchFailure('invalid_request', '公开正文身份重复');
    captures.set(capture.captureId, capture);
  }
  const included = new Set<string>();
  for (const inclusion of state.inclusions) {
    if (included.has(inclusion.captureId) || captures.get(inclusion.captureId)?.contentSha256 !== inclusion.contentSha256)
      throw new ResearchFailure('invalid_request', '公开来源纳入记录与正文不匹配');
    included.add(inclusion.captureId);
  }
}
