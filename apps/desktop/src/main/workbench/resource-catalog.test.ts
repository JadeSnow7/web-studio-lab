import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CatalogCommandSchema, ResourceDescriptorSchema } from '@wsl/protocol';
import {
  applyCatalogCommand,
  appendResourceRevision,
  createResourceCatalog,
  freezeCatalogReferences,
  listLibrary,
  MAX_APPLIED_CATALOG_COMMANDS,
} from './resource-catalog';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const itemAt = <T>(items: T[], index = 0): T => {
  const item = items[index];
  if (item === undefined) throw new Error('fixture item missing');
  return item;
};
const now = '2026-10-10T00:00:00.000Z';
const context = { accountId: 'local-account', now, workspaceIds: ['A', 'B'], dependencies: [] };
const bookmark = (commandId = 'bookmark') => ({
  type: 'bookmarkLink' as const,
  commandId,
  expectedCatalogRevision: 0,
  title: '文档',
  url: 'https://example.com/doc',
});
const make = () => applyCatalogCommand(createResourceCatalog(context.accountId), bookmark(), context);
const revision = (resourceId: string, text = 'v1', url = 'https://example.com/doc') => {
  const snapshot = {
    requestedUrl: url,
    url,
    title: '文档',
    text,
    capturedAt: now,
    contentSha256: sha(text),
    sourceSha256: sha(text),
    truncated: false,
    extractionVersion: 'html-text-v1' as const,
    page: { webContentsId: 1, documentGeneration: 0, url, title: '文档', partition: 'test' },
  };
  return {
    resourceId,
    capturedAt: now,
    text,
    contentSha256: sha(text),
    sourceSha256: sha(text),
    truncated: false,
    evidence: { kind: 'web' as const, snapshot },
  };
};

describe('RESOURCE-OWNERSHIP-1 model R01-R11', () => {
  it('R01/R02 bookmarks independently from workspace, deduplicates command and explicit resource reuse', () => {
    const state = make();
    expect(listLibrary(state)).toHaveLength(1);
    expect(state.links).toEqual([]);
    expect(applyCatalogCommand(state, bookmark(), context)).toEqual(state);
    const id = itemAt(state.resources).resourceId;
    let next = state;
    for (const workspaceId of ['A', 'B', 'A'])
      next = applyCatalogCommand(
        next,
        {
          type: 'connectResource',
          commandId: workspaceId + next.revision,
          expectedCatalogRevision: next.revision,
          workspaceId,
          resourceId: id,
        },
        context,
      );
    expect(next.resources).toHaveLength(1);
    expect(next.links).toHaveLength(2);
    expect(
      applyCatalogCommand(
        next,
        { type: 'bookmarkResource', commandId: 'again', expectedCatalogRevision: next.revision, resourceId: id },
        context,
      ).library,
    ).toHaveLength(1);
  });
  it('R03/R04 separates unbookmark, disconnect and deletion, refusing active dependencies', () => {
    let state = make();
    const resourceId = itemAt(state.resources).resourceId;
    for (const workspaceId of ['A', 'B'])
      state = applyCatalogCommand(
        state,
        { type: 'connectResource', commandId: workspaceId, expectedCatalogRevision: state.revision, workspaceId, resourceId },
        context,
      );
    state = appendResourceRevision(state, revision(resourceId), state.revision, context);
    state = applyCatalogCommand(
      state,
      { type: 'unbookmarkResource', commandId: 'unbookmark', expectedCatalogRevision: state.revision, resourceId },
      context,
    );
    expect(listLibrary(state)).toEqual([]);
    expect(state.links).toHaveLength(2);
    expect(state.revisions).toHaveLength(1);
    const disconnect = {
      type: 'disconnectResource' as const,
      commandId: 'remove-A',
      expectedCatalogRevision: state.revision,
      workspaceId: 'A',
      resourceId,
    };
    for (const kind of ['instance', 'tab', 'turn'] as const)
      expect(() => applyCatalogCommand(state, disconnect, { ...context, dependencies: [{ workspaceId: 'A', resourceId, kind }] })).toThrow(
        /依赖/,
      );
    state = applyCatalogCommand(state, disconnect, context);
    expect(state.links.map((link) => link.workspaceId)).toEqual(['B']);
    expect(() =>
      applyCatalogCommand(
        state,
        { type: 'deleteResource', commandId: 'delete', expectedCatalogRevision: state.revision, resourceId },
        context,
      ),
    ).toThrow(/连接/);
  });
  it('R05/R06 freezes only selected connected versions, keeps v1 after v2 and prevents foreign references', () => {
    let state = make();
    const resourceId = itemAt(state.resources).resourceId;
    state = appendResourceRevision(state, revision(resourceId), state.revision, context);
    expect(freezeCatalogReferences(state, { workspaceId: 'A', sessionId: 'session', references: [] })).toMatchObject({ resources: [] });
    state = applyCatalogCommand(
      state,
      { type: 'connectResource', commandId: 'A', expectedCatalogRevision: state.revision, workspaceId: 'A', resourceId },
      context,
    );
    expect(freezeCatalogReferences(state, { workspaceId: 'A', sessionId: 'session', references: [] }).resources).toEqual([]);
    state = applyCatalogCommand(
      state,
      { type: 'selectReference', commandId: 'ref', expectedCatalogRevision: state.revision, workspaceId: 'A', resourceId, version: 1 },
      context,
    );
    const frozen = freezeCatalogReferences(state, { workspaceId: 'A', sessionId: 'session', references: [] });
    state = appendResourceRevision(state, revision(resourceId, 'v2'), state.revision, context);
    expect(frozen.resources[0]?.version).toBe(1);
    expect(frozen.resources[0]?.text).toBe('v1');
    expect(freezeCatalogReferences(state, { workspaceId: 'A', sessionId: 'session', references: [] }).resources[0]?.text).toBe('v1');
    expect(() =>
      freezeCatalogReferences(state, { workspaceId: 'B', sessionId: 'session', references: [{ resourceId, version: 1 }] }),
    ).toThrow();
    expect(
      freezeCatalogReferences(state, { workspaceId: null, sessionId: 'personal', references: [{ resourceId, version: 2 }] }).resources[0]
        ?.text,
    ).toBe('v2');
    state = applyCatalogCommand(
      state,
      { type: 'unbookmarkResource', commandId: 'unmark', expectedCatalogRevision: state.revision, resourceId },
      context,
    );
    expect(() =>
      freezeCatalogReferences(state, { workspaceId: null, sessionId: 'personal', references: [{ resourceId, version: 1 }] }),
    ).toThrow(/收藏/);
  });
  it('R07 allows 17 favorites but rejects 17 selected references and full JSON overflow', () => {
    let state = createResourceCatalog(context.accountId);
    for (let n = 0; n < 17; n++) {
      state = applyCatalogCommand(
        state,
        { ...bookmark('b' + n), expectedCatalogRevision: state.revision, url: 'https://example.com/' + n },
        context,
      );
      state = appendResourceRevision(
        state,
        revision(itemAt(state.resources, n).resourceId, 'x'.repeat(65536), 'https://example.com/' + n),
        state.revision,
        context,
      );
    }
    expect(listLibrary(state)).toHaveLength(17);
    const references = state.resources.map(({ resourceId }) => ({ resourceId, version: 1 }));
    expect(() => freezeCatalogReferences(state, { workspaceId: null, sessionId: 'p', references })).toThrow(/16/);
    expect(() => freezeCatalogReferences(state, { workspaceId: null, sessionId: 'p', references: references.slice(0, 8) })).toThrow(/字节/);
  });
  it('R08/R10 rejects forged identity, unknown resource/workspace, stale revision and digest without mutation', () => {
    const state = make();
    expect(CatalogCommandSchema.safeParse({ ...bookmark(), ownerAccountId: 'attacker' }).success).toBe(false);
    expect(() => applyCatalogCommand(state, { ...bookmark('stale') }, context)).toThrow(/冲突/);
    expect(() =>
      applyCatalogCommand(
        state,
        {
          type: 'connectResource',
          commandId: 'bad',
          expectedCatalogRevision: state.revision,
          resourceId: itemAt(state.resources).resourceId,
          workspaceId: 'foreign',
        },
        context,
      ),
    ).toThrow(/空间/);
    expect(() =>
      applyCatalogCommand(
        state,
        { type: 'bookmarkResource', commandId: 'missing', expectedCatalogRevision: state.revision, resourceId: 'missing' },
        context,
      ),
    ).toThrow(/资源/);
    expect(() => applyCatalogCommand(state, bookmark(), { ...context, accountId: 'foreign' })).toThrow(/账户/);
    expect(() =>
      appendResourceRevision(
        state,
        { ...revision(itemAt(state.resources).resourceId), contentSha256: sha('wrong') },
        state.revision,
        context,
      ),
    ).toThrow(/摘要/);
    expect(() =>
      appendResourceRevision(
        state,
        {
          ...revision(itemAt(state.resources).resourceId),
          evidence: { kind: 'file', environmentId: 'local', path: '/doc', fileVersion: '1' },
        },
        state.revision,
        context,
      ),
    ).toThrow(/类型/);
    expect(state.revision).toBe(1);
    expect(state.revisions).toEqual([]);
    expect(() => applyCatalogCommand(state, { ...bookmark(), title: 'command reused' }, context)).toThrow(/命令/);
  });
  it('R11 permits only reopenable web/document/development descriptors, not sessions or credentials', () => {
    for (const descriptor of [
      { kind: 'web', url: 'https://example.com' },
      { kind: 'document', environmentId: 'local', path: '/allowed/doc' },
      { kind: 'development', entryKind: 'terminal', environmentId: 'sandbox', path: null, projectId: null },
    ])
      expect(ResourceDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const descriptor of [
      { kind: 'session' },
      { kind: 'web', url: 'https://u:p@example.com' },
      { kind: 'development', entryKind: 'terminal', environmentId: 'sandbox', password: 'secret' },
    ])
      expect(ResourceDescriptorSchema.safeParse(descriptor).success).toBe(false);
  });
});

describe('persisted command deduplication window', () => {
  it('keeps only the most recent command IDs and rejects a replay of an evicted ID as a revision conflict', () => {
    let state = make();
    const resourceId = itemAt(state.resources).resourceId;
    const title = (index: number) => ({
      type: 'updateResource' as const,
      commandId: 'rename-' + index,
      expectedCatalogRevision: state.revision,
      resourceId,
      title: 'title ' + index,
    });
    const first = title(0);
    for (let index = 0; index <= MAX_APPLIED_CATALOG_COMMANDS; index++)
      state = applyCatalogCommand(state, index ? title(index) : first, context);
    expect(state.appliedCommands).toHaveLength(MAX_APPLIED_CATALOG_COMMANDS);
    expect(state.appliedCommands.at(-1)?.commandId).toBe('rename-' + MAX_APPLIED_CATALOG_COMMANDS);
    expect(state.appliedCommands.some((command) => command.commandId === first.commandId)).toBe(false);
    expect(() => applyCatalogCommand(state, first, context)).toThrow('conflict');
    expect(itemAt(state.resources).title).toBe('title ' + MAX_APPLIED_CATALOG_COMMANDS);
  });
});
