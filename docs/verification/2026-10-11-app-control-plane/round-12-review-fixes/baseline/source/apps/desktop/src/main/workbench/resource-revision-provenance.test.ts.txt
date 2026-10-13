import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CatalogActionSchema,
  ResourceBundleSchema,
  type ResourceCatalogState,
  type PageResourceSnapshot,
  type GuestPageResourceSnapshot,
} from '@wsl/protocol';
import { appendResourceRevision, applyCatalogCommand, createResourceCatalog } from './resource-catalog';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const now = '2026-10-10T00:00:00.000Z';
const context = { accountId: 'test', now, workspaceIds: ['A', 'B'], dependencies: [] };
const snapshot = (
  text = 'Example Domain',
  url = 'https://example.com/',
): Extract<PageResourceSnapshot, { extractionVersion: 'html-text-v1' }> => ({
  page: { webContentsId: 7, documentGeneration: 2, url, title: 'Example Domain', partition: 'persist:preview' },
  requestedUrl: url,
  url,
  title: 'Example Domain',
  text,
  capturedAt: now,
  sourceSha256: sha('<html>source</html>'),
  contentSha256: sha(text),
  extractionVersion: 'html-text-v1',
  truncated: false,
});
function initial() {
  return applyCatalogCommand(
    createResourceCatalog('test'),
    { type: 'bookmarkLink', commandId: 'bookmark', expectedCatalogRevision: 0, title: 'Example Domain', url: snapshot().url },
    context,
  );
}
function append(state: ResourceCatalogState, value: PageResourceSnapshot) {
  const resourceId = state.resources[0]?.resourceId;
  if (!resourceId) throw new Error('missing fixture resource');
  return appendResourceRevision(
    state,
    {
      resourceId,
      text: value.text,
      capturedAt: value.capturedAt,
      contentSha256: value.contentSha256,
      sourceSha256: value.sourceSha256,
      truncated: value.truncated,
      evidence: { kind: 'web', snapshot: value },
    },
    state.revision,
    context,
  );
}
const guestSnapshot = (): GuestPageResourceSnapshot => ({
  ...snapshot(),
  page: {
    kind: 'sandbox-chromium',
    sandboxName: 'wsl-sbx-smoke-20261006',
    browserInstanceId: '5cd9a82c-d94e-4774-854d-e58083e49e9b',
    targetId: 'CDP-TARGET-1',
    navigationEpoch: 1,
    url: 'https://example.com/',
    title: 'Example Domain',
  },
  extractionVersion: 'rendered-dom-text-v1',
  sourceKind: 'decoded-main-response',
  captureId: '9106578b-e2ce-4c19-a8b7-06753245eaa5',
  screenshotSha256: 'c'.repeat(64),
});

describe('resource authority replacement and immutable capture provenance', () => {
  it('rejects retired renderer operations and forged capture body/owner', () => {
    expect(
      CatalogActionSchema.safeParse({ type: 'capturePublicResource', commandId: 'old', workspaceId: 'A', resourceId: 'r' }).success,
    ).toBe(false);
    const command = {
      type: 'captureResourceRevision',
      commandId: 'new',
      expectedCatalogRevision: 0,
      workspaceId: 'A',
      runtimeResourceId: 'r',
    };
    expect(CatalogActionSchema.safeParse(command).success).toBe(true);
    expect(CatalogActionSchema.safeParse({ ...command, text: 'forged' }).success).toBe(false);
    expect(CatalogActionSchema.safeParse({ ...command, ownerAccountId: 'forged' }).success).toBe(false);
  });
  it('records immutable versions with the same account identity and preserves earlier body', () => {
    const first = append(initial(), snapshot());
    const second = append(first, snapshot('Updated'));
    expect(second.revisions.map(({ version }) => version)).toEqual([1, 2]);
    expect(first.revisions[0]?.text).toBe('Example Domain');
    expect(second.revisions[0]?.resourceId).toBe(second.revisions[1]?.resourceId);
  });
  it('rejects different URL, forged digest and mismatched source without mutating committed state', () => {
    const first = append(initial(), snapshot());
    for (const value of [
      snapshot('other', 'https://other.example/'),
      { ...snapshot(), contentSha256: '0'.repeat(64) },
      { ...snapshot(), text: 'tampered' },
    ])
      expect(() => append(first, value)).toThrow();
    expect(first.revisions).toHaveLength(1);
  });
  it('requires complete bounded turn JSON rather than imposing a personal collection quota', () => {
    const references = {
      accountId: 'test',
      workspaceId: null,
      sessionId: 'conv-personal-default',
      catalogRevision: 0,
      resources: [],
      conversationId: 'conv-personal-default',
      generation: 'g',
      turnId: 't',
    };
    expect(ResourceBundleSchema.safeParse(references).success).toBe(true);
    expect(ResourceBundleSchema.safeParse({ ...references, accountId: '../forged' }).success).toBe(false);
  });
  it('preserves exact guest identity independently from host pages', () => {
    const state = append(initial(), guestSnapshot());
    expect(state.revisions[0]?.evidence).toEqual({ kind: 'web', snapshot: guestSnapshot() });
  });
  const changedArtifacts: [string, (input: GuestPageResourceSnapshot) => void][] = [
    [
      'capture',
      (input) => {
        input.captureId = '047e64b6-7f96-4402-ad2c-c1a3d789aa21';
      },
    ],
    [
      'capture time',
      (input) => {
        input.capturedAt = '2026-10-06T16:01:00.000Z';
      },
    ],
    [
      'main response',
      (input) => {
        input.sourceSha256 = 'd'.repeat(64);
      },
    ],
    [
      'screenshot',
      (input) => {
        input.screenshotSha256 = 'd'.repeat(64);
      },
    ],
    [
      'browser',
      (input) => {
        input.page.browserInstanceId = '047e64b6-7f96-4402-ad2c-c1a3d789aa21';
      },
    ],
    [
      'target',
      (input) => {
        input.page.targetId = 'CDP-TARGET-2';
      },
    ],
    [
      'navigation',
      (input) => {
        input.page.navigationEpoch = 2;
      },
    ],
    [
      'sandbox',
      (input) => {
        input.page.sandboxName = 'different-sandbox';
      },
    ],
    [
      'requested URL',
      (input) => {
        input.requestedUrl = 'https://example.com/redirect';
      },
    ],
    [
      'truncation',
      (input) => {
        input.truncated = true;
      },
    ],
  ];
  it.each(changedArtifacts)('new %s appends provenance without changing the previous artifact', (_label, mutate) => {
    const original = guestSnapshot();
    const first = append(initial(), original);
    const changed = guestSnapshot();
    mutate(changed);
    const second = append(first, changed);
    expect(second.revisions[1]).toMatchObject({ version: 2, evidence: { kind: 'web', snapshot: changed } });
    expect(first.revisions[0]?.evidence).toEqual({ kind: 'web', snapshot: original });
    expect(second.revisions[0]?.evidence).toEqual({ kind: 'web', snapshot: original });
  });
  it('host and guest evidence remain separate complete variants across successive versions', () => {
    const host = append(initial(), snapshot());
    const guest = append(host, guestSnapshot());
    const restored = append(guest, snapshot());
    expect(restored.revisions.map(({ evidence }) => evidence.kind === 'web' && evidence.snapshot.extractionVersion)).toEqual([
      'html-text-v1',
      'rendered-dom-text-v1',
      'html-text-v1',
    ]);
    expect(restored.revisions[2]?.evidence).not.toHaveProperty('snapshot.captureId');
  });
});
