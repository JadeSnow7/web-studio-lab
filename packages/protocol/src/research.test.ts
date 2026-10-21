import { describe, expect, it } from 'vitest';
import { ChatConversationSchema, ChatSendSchema, ChatServiceMessageSchema, ChatServiceRequestSchema } from './chat';
import { ObservationRequestSchema } from './observation';
import { WorkbenchCommandSchema, WorkbenchRunSchema, WorkbenchTaskVersionSchema } from './workspace';
import { utf8ByteLength } from './resources';
import {
  MAX_RESEARCH_BYTES,
  MAX_RESEARCH_TEXT_BYTES,
  ResearchCallSchema,
  ResearchCaptureSchema,
  ResearchCaptureSummarySchema,
  ResearchGrantSchema,
  ResearchNativeSearchRecordsSchema,
  ResearchReplySchema,
  ResearchRunStateSchema,
  ResearchRunSummarySchema,
  ResearchToolInputSchema,
  ResearchToolResultSchema,
} from './research';

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
const now = '2026-10-15T15:00:00.000Z';
// DTO fixtures check identity matching; Main/repository tests recompute real SHA-256.
const contentHash = 'a'.repeat(64);
const otherHash = 'c'.repeat(64);
const grant = {
  grantId: uuid(1),
  accountId: 'account',
  workspaceId: 'workspace',
  sessionId: 'session-research',
  taskVersionId: 'task-version',
  runId: 'run',
  mode: 'live',
  purpose: 'public-web-research',
  grantedAt: now,
} as const;
const context = { grant, generation: 'generation', turnId: 'turn' };
const capture = (index = 2, text = '实际正文🙂') => ({
  captureId: uuid(index),
  readerResourceId: 'research-reader',
  requestedUrl: 'https://example.com/requested',
  url: 'https://example.com/article',
  title: '文章',
  capturedAt: now,
  sourceSha256: 'b'.repeat(64),
  contentSha256: contentHash,
  extractionVersion: 'html-text-v1' as const,
  truncated: false,
  textBytes: utf8ByteLength(text),
  text,
  page: { webContentsId: 9, documentGeneration: 2, url: 'https://example.com/article', title: '文章', partition: 'reader' },
});
const summary = (value = capture()) => {
  const { text: _text, page: _page, ...metadata } = value;
  return metadata;
};
const inclusion = { captureId: uuid(2), contentSha256: capture().contentSha256, includedAt: now };
const state = { grant, captures: [capture()], inclusions: [inclusion] };
const references = {
  accountId: grant.accountId,
  workspaceId: grant.workspaceId,
  sessionId: grant.sessionId,
  catalogRevision: 1,
  resources: [],
};
const scope = { workspaceId: grant.workspaceId, sessionId: grant.sessionId, runId: grant.runId, sources: [] };
const send = { conversationId: grant.sessionId, text: '公开研究', references, observationScope: scope, researchGrant: grant };
const run = {
  runId: grant.runId,
  workspaceId: grant.workspaceId,
  sessionId: grant.sessionId,
  taskVersionId: grant.taskVersionId,
  targetRef: null,
  state: 'completed',
  startedAt: now,
  endedAt: now,
  error: null,
  candidateId: 'candidate',
  validation: { state: 'not_run', applicability: 'unknown', reason: null },
  review: null,
};
const conversation = {
  conversationId: grant.sessionId,
  generation: context.generation,
  seq: 1,
  threadId: 'thread',
  turnId: context.turnId,
  state: 'idle',
  messages: [],
  toolExecutions: [],
  warnings: [],
  cleanupPending: false,
  error: null,
};
const nativeSearch = {
  itemId: 'search-item',
  turnId: 'turn',
  status: 'completed',
  observedAt: now,
  query: '公开资料',
  candidateUrls: ['http://example.com/candidate'],
  schemaUnsupported: false,
  truncated: false,
};

describe('task-scoped public research protocol', () => {
  it('accepts only an explicit bounded live grant, without arbitrary permission fields', () => {
    expect(ResearchGrantSchema.parse(grant)).toEqual(grant);
    for (const invalid of [
      { ...grant, grantId: 'not-uuid' },
      { ...grant, mode: 'cached' },
      { ...grant, purpose: 'general-network' },
      { ...grant, accountId: '' },
      { ...grant, grantedAt: 'yesterday' },
      { ...grant, allowedScopes: ['*'] },
      { ...grant, projectId: 'caller-project' },
    ])
      expect(ResearchGrantSchema.safeParse(invalid).success).toBe(false);
  });

  it('adds an ephemeral start option without creating an old-run or task-version preference', () => {
    const start = {
      type: 'startRun',
      commandId: 'command',
      workspaceId: grant.workspaceId,
      sessionId: grant.sessionId,
      taskVersionId: grant.taskVersionId,
    };
    expect(WorkbenchCommandSchema.parse(start)).not.toHaveProperty('webResearch');
    for (const webResearch of [true, false]) expect(WorkbenchCommandSchema.parse({ ...start, webResearch })).toMatchObject({ webResearch });
    expect(WorkbenchCommandSchema.safeParse({ ...start, webResearch: 'true' }).success).toBe(false);
    const confirm = {
      type: 'confirmTask',
      commandId: 'confirm',
      workspaceId: grant.workspaceId,
      sessionId: grant.sessionId,
      goal: 'goal',
      targetRef: null,
    };
    expect(WorkbenchCommandSchema.safeParse({ ...confirm, webResearch: true }).success).toBe(false);
    expect(
      WorkbenchCommandSchema.safeParse({
        type: 'saveTaskCriteria',
        commandId: 'criteria',
        workspaceId: grant.workspaceId,
        sessionId: grant.sessionId,
        webResearch: true,
      }).success,
    ).toBe(false);
    const version = WorkbenchTaskVersionSchema.parse({
      taskVersionId: grant.taskVersionId,
      version: 1,
      workspaceId: grant.workspaceId,
      sessionId: grant.sessionId,
      goal: 'goal',
      targetRef: null,
      capture: null,
      confirmedAt: now,
    });
    expect(version).not.toHaveProperty('webResearch');
    expect(WorkbenchRunSchema.parse(run)).not.toHaveProperty('research');
    expect(WorkbenchRunSchema.parse(run)).not.toHaveProperty('researchSummary');
  });

  it.each(['accountId', 'workspaceId', 'sessionId', 'runId'] as const)('rejects a send grant for another %s', (field) => {
    expect(ChatSendSchema.safeParse({ ...send, researchGrant: { ...grant, [field]: 'foreign' } }).success).toBe(false);
  });

  it('requires the existing observed run and references, without granting personal chat research', () => {
    expect(ChatSendSchema.parse(send)).toEqual(send);
    expect(ChatSendSchema.safeParse({ ...send, observationScope: undefined }).success).toBe(false);
    expect(ChatSendSchema.safeParse({ ...send, references: { ...references, workspaceId: null } }).success).toBe(false);
    expect(ChatSendSchema.safeParse({ ...send, observationScope: { ...scope, sessionId: 'session-foreign' } }).success).toBe(false);
    expect(ChatSendSchema.safeParse({ ...send, conversationId: 'conv-personal-default' }).success).toBe(false);
    expect(
      ChatSendSchema.safeParse({
        ...send,
        conversationId: 'conv-personal-default',
        researchGrant: { ...grant, sessionId: 'conv-personal-default' },
        references: { ...references, sessionId: 'conv-personal-default' },
        observationScope: { ...scope, sessionId: 'conv-personal-default' },
      }).success,
    ).toBe(false);
    const { researchGrant: _grant, ...ordinary } = send;
    expect(ChatSendSchema.parse(ordinary)).not.toHaveProperty('researchGrant');
  });

  it('keeps edu and Mota task capabilities exclusive with research', () => {
    const eduTask = {
      runId: uuid(3),
      workspaceId: grant.workspaceId,
      projectId: uuid(4),
      appInstanceId: uuid(5),
      resourceId: 'app',
      instanceId: 'instance',
      generation: 1,
      webContentsId: 3,
      documentGeneration: 2,
      sourceSha256: 'a'.repeat(64),
      protectedFiles: [{ path: 'admin/src/App.tsx', sha256: 'b'.repeat(64), bytes: 1 }],
    };
    const eduSend = {
      ...send,
      observationScope: { ...scope, runId: eduTask.runId },
      researchGrant: { ...grant, runId: eduTask.runId },
      eduTask,
    };
    const { researchGrant: _eduGrant, ...ordinaryEdu } = eduSend;
    expect(ChatSendSchema.safeParse(ordinaryEdu).success).toBe(true);
    expect(ChatSendSchema.safeParse(eduSend).success).toBe(false);
    const motaTask = {
      workspaceId: grant.workspaceId,
      environmentId: 'sandbox',
      projectId: 'project',
      appInstanceId: 'app',
      runId: grant.runId,
      sessionId: grant.sessionId,
      resourceId: 'game',
      browserInstanceId: 'browser',
      browserGeneration: 1,
      webContentsId: 4,
      documentGeneration: 2,
    };
    const { researchGrant: _motaGrant, ...ordinaryMota } = { ...send, motaTask };
    expect(ChatSendSchema.safeParse(ordinaryMota).success).toBe(true);
    expect(ChatSendSchema.safeParse({ ...send, motaTask }).success).toBe(false);
  });

  it('requires a URL for open and an immutable capture/hash for include, never caller text or identity', () => {
    expect(ResearchToolInputSchema.parse({ tool: 'research.open', args: { url: 'https://example.com/article' } })).toBeTruthy();
    expect(
      ResearchToolInputSchema.parse({ tool: 'research.include', args: { captureId: uuid(2), contentSha256: contentHash } }),
    ).toBeTruthy();
    for (const url of ['http://example.com', 'file:///tmp/data', 'https://user:password@example.com'])
      expect(ResearchToolInputSchema.safeParse({ tool: 'research.open', args: { url } }).success).toBe(false);
    for (const args of [
      { captureId: uuid(2) },
      { captureId: uuid(2), contentSha256: 'A'.repeat(64) },
      { captureId: uuid(2), contentSha256: contentHash, text: 'model body' },
      { captureId: uuid(2), contentSha256: contentHash, workspaceId: 'foreign' },
      { captureId: uuid(2), contentSha256: contentHash, url: 'https://example.com' },
    ])
      expect(ResearchToolInputSchema.safeParse({ tool: 'research.include', args }).success).toBe(false);
    expect(ResearchToolInputSchema.safeParse({ tool: 'research.search', args: { query: 'query' } }).success).toBe(false);
  });

  it('round-trips the strict flat call/abort/reply envelopes without changing observation tools', () => {
    const call = { callId: uuid(6), context, tool: 'research.open', args: { url: 'https://example.com/article' } };
    expect(ResearchCallSchema.parse(call)).toEqual(call);
    expect(ChatServiceMessageSchema.parse({ type: 'research-call', ...call })).toEqual({ type: 'research-call', ...call });
    const includeCall = { ...call, tool: 'research.include', args: { captureId: uuid(2), contentSha256: capture().contentSha256 } };
    expect(ChatServiceMessageSchema.parse({ type: 'research-call', ...includeCall })).toEqual({ type: 'research-call', ...includeCall });
    expect(ChatServiceMessageSchema.parse({ type: 'research-abort', callId: call.callId })).toEqual({
      type: 'research-abort',
      callId: call.callId,
    });
    const reply = { callId: call.callId, context, result: { ok: true, tool: 'research.open', capture: summary() } };
    expect(ResearchReplySchema.parse(reply)).toEqual(reply);
    expect(ChatServiceRequestSchema.parse({ id: 'request', method: 'research.reply', payload: reply })).toEqual({
      id: 'request',
      method: 'research.reply',
      payload: reply,
    });
    expect(ResearchCallSchema.safeParse({ ...call, context: { grant } }).success).toBe(false);
    expect(ResearchCallSchema.safeParse({ ...call, context: { ...context, runId: 'caller-run' } }).success).toBe(false);
    expect(
      ObservationRequestSchema.safeParse({
        requestId: 'request',
        workspaceId: grant.workspaceId,
        sessionId: grant.sessionId,
        runId: grant.runId,
        target: null,
        tool: 'research.open',
        args: call.args,
      }).success,
    ).toBe(false);
  });

  it('requires exact capture page metadata and UTF-8 byte counts, without silently normalizing body bytes', () => {
    const value = capture();
    expect(ResearchCaptureSchema.parse(value)).toEqual(value);
    expect(value.textBytes).toBeGreaterThan(value.text.length);
    for (const invalid of [
      { ...value, textBytes: value.text.length },
      { ...value, text: value.text + '\n' },
      { ...value, page: { ...value.page, url: 'https://example.com/other' } },
      { ...value, page: { ...value.page, title: 'other' } },
      { ...value, extractionVersion: 'rendered-dom-text-v1' },
    ])
      expect(ResearchCaptureSchema.safeParse(invalid).success).toBe(false);
    expect(ResearchCaptureSchema.safeParse(capture(2, 'a'.repeat(MAX_RESEARCH_TEXT_BYTES))).success).toBe(true);
    expect(ResearchCaptureSchema.safeParse(capture(2, 'a'.repeat(MAX_RESEARCH_TEXT_BYTES) + '🙂')).success).toBe(false);
  });

  it('keeps successful open metadata-only and include body-bound, with explicit failure codes', () => {
    const open = { ok: true, tool: 'research.open', capture: summary() };
    expect(ResearchToolResultSchema.parse(open)).toEqual(open);
    expect(ResearchToolResultSchema.safeParse({ ...open, capture: capture() }).success).toBe(false);
    const source = { ...summary(), includedAt: now, text: capture().text };
    expect(ResearchToolResultSchema.parse({ ok: true, tool: 'research.include', source })).toMatchObject({ source });
    expect(
      ResearchToolResultSchema.safeParse({ ok: true, tool: 'research.include', source: { ...summary(), includedAt: now } }).success,
    ).toBe(false);
    expect(
      ResearchToolResultSchema.safeParse({ ok: true, tool: 'research.include', source: { ...source, text: 'different' } }).success,
    ).toBe(false);
    expect(
      ResearchToolResultSchema.parse({ ok: false, tool: 'research.include', error: { code: 'storage_failed', message: '保存失败' } }),
    ).toBeTruthy();
    expect(
      ResearchToolResultSchema.safeParse({ ok: false, tool: 'research.include', error: { code: 'ignored', message: 'error' } }).success,
    ).toBe(false);
  });

  it('separates complete stored captures from strict public summaries', () => {
    expect(ResearchRunStateSchema.parse(state)).toEqual(state);
    const publicState = { ...state, captures: state.captures.map(summary) };
    expect(ResearchRunSummarySchema.parse(publicState)).toEqual(publicState);
    expect(ResearchRunSummarySchema.safeParse(state).success).toBe(false);
    expect(ResearchRunStateSchema.safeParse(publicState).success).toBe(false);
    expect(ResearchCaptureSummarySchema.safeParse(capture()).success).toBe(false);
    expect(WorkbenchRunSchema.parse({ ...run, research: state })).toMatchObject({ research: state });
    const visible = WorkbenchRunSchema.parse({ ...run, researchSummary: publicState });
    expect(visible).not.toHaveProperty('research');
    expect(JSON.stringify(visible)).not.toContain(capture().text);
  });

  it('rejects duplicate captures/inclusions and inclusion hashes that do not identify an existing capture', () => {
    for (const invalid of [
      { ...state, captures: [capture(), capture()] },
      { ...state, inclusions: [inclusion, inclusion] },
      { ...state, inclusions: [{ ...inclusion, captureId: uuid(99) }] },
      { ...state, inclusions: [{ ...inclusion, contentSha256: otherHash }] },
    ])
      expect(ResearchRunStateSchema.safeParse(invalid).success).toBe(false);
  });

  it.each(['workspaceId', 'sessionId', 'taskVersionId', 'runId'] as const)('rejects research persisted on a different %s', (field) => {
    expect(WorkbenchRunSchema.safeParse({ ...run, research: { ...state, grant: { ...grant, [field]: 'foreign' } } }).success).toBe(false);
    expect(
      WorkbenchRunSchema.safeParse({
        ...run,
        researchSummary: { ...state, grant: { ...grant, [field]: 'foreign' }, captures: [summary()] },
      }).success,
    ).toBe(false);
  });

  it('counts initial references and all captured sources, even before inclusion', () => {
    const reference = {
      resourceId: 'reference',
      version: 1,
      capturedAt: now,
      text: '',
      contentSha256: contentHash,
      sourceSha256: contentHash,
      truncated: false,
      evidence: { kind: 'file', environmentId: 'local', path: '/chosen/reference.txt', fileVersion: 'v1' },
    };
    const completeReferences = { ...references, resources: [reference] };
    const captures = Array.from({ length: 16 }, (_, index) => capture(index + 2, ''));
    expect(ResearchRunStateSchema.safeParse({ grant, captures, inclusions: [] }).success).toBe(true);
    expect(
      WorkbenchRunSchema.safeParse({
        ...run,
        referenceSnapshot: completeReferences,
        research: { grant, captures: captures.slice(0, 15), inclusions: [] },
      }).success,
    ).toBe(true);
    expect(
      WorkbenchRunSchema.safeParse({ ...run, referenceSnapshot: completeReferences, research: { grant, captures, inclusions: [] } })
        .success,
    ).toBe(false);
    expect(
      WorkbenchRunSchema.safeParse({ ...run, referenceSnapshot: { ...completeReferences, accountId: 'foreign' }, research: state }).success,
    ).toBe(false);
    for (const field of ['workspaceId', 'sessionId'] as const)
      expect(
        WorkbenchRunSchema.safeParse({ ...run, referenceSnapshot: { ...completeReferences, [field]: 'foreign' }, research: state }).success,
      ).toBe(false);
  });

  it('enforces a joint complete-JSON byte budget rather than only summed body bytes', () => {
    const text = 'a'.repeat(MAX_RESEARCH_TEXT_BYTES);
    const captures = Array.from({ length: 7 }, (_, index) => capture(index + 2, text));
    const research = { grant, captures, inclusions: [] };
    expect(ResearchRunStateSchema.safeParse(research).success).toBe(true);
    const reference = {
      resourceId: 'reference',
      version: 1,
      capturedAt: now,
      text,
      contentSha256: contentHash,
      sourceSha256: contentHash,
      truncated: false,
      evidence: { kind: 'file', environmentId: 'local', path: '/chosen/reference.txt', fileVersion: 'v1' },
    };
    const referenceSnapshot = { ...references, resources: [reference] };
    expect(text.length * 8).toBe(MAX_RESEARCH_BYTES);
    expect(utf8ByteLength(JSON.stringify({ references: referenceSnapshot, research }))).toBeGreaterThan(MAX_RESEARCH_BYTES);
    expect(WorkbenchRunSchema.safeParse({ ...run, referenceSnapshot, research }).success).toBe(false);
    expect(
      WorkbenchRunSchema.safeParse({ ...run, referenceSnapshot, research: { ...research, captures: captures.slice(1) } }).success,
    ).toBe(true);
  });

  it('bounds native search audit by complete UTF-8 JSON while keeping candidates distinct from captures', () => {
    expect(ResearchNativeSearchRecordsSchema.parse([nativeSearch])).toEqual([nativeSearch]);
    expect(
      ResearchNativeSearchRecordsSchema.safeParse([{ ...nativeSearch, candidateUrls: ['https://user:password@example.com'] }]).success,
    ).toBe(false);
    const old = ChatConversationSchema.parse(conversation);
    expect(old).not.toHaveProperty('nativeSearches');
    expect(old).not.toHaveProperty('nativeSearchesTruncated');
    const incomplete = {
      ...nativeSearch,
      status: 'unknown',
      schemaUnsupported: true,
      truncated: true,
      query: undefined,
      candidateUrls: undefined,
    };
    expect(ChatConversationSchema.parse({ ...conversation, nativeSearches: [incomplete], nativeSearchesTruncated: true })).toMatchObject({
      nativeSearchesTruncated: true,
    });
    expect(
      ResearchNativeSearchRecordsSchema.safeParse(Array.from({ length: 33 }, (_, index) => ({ ...nativeSearch, itemId: `item-${index}` })))
        .success,
    ).toBe(false);
    const oversized = Array.from({ length: 6 }, (_, index) => ({ ...nativeSearch, itemId: `item-${index}`, query: '中'.repeat(4000) }));
    expect(JSON.stringify(oversized).length).toBeLessThan(65536);
    expect(utf8ByteLength(JSON.stringify(oversized))).toBeGreaterThan(65536);
    expect(ResearchNativeSearchRecordsSchema.safeParse(oversized).success).toBe(false);
    expect(ResearchRunStateSchema.safeParse({ grant, captures: [nativeSearch], inclusions: [] }).success).toBe(false);
  });
});
