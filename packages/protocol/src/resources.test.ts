import { ResourceBundleSchema } from './resource-catalog';
import { describe, expect, it } from 'vitest';
import { GuestPageResourceSnapshotSchema, PageResourceSnapshotSchema, utf8ByteLength, type GuestPageResourceSnapshot } from './resources';

const guest = (): GuestPageResourceSnapshot => ({
  page: {
    kind: 'sandbox-chromium',
    sandboxName: 'wsl-sbx-smoke-20261006',
    browserInstanceId: '5cd9a82c-d94e-4774-854d-e58083e49e9b',
    targetId: 'CDP-TARGET-1',
    navigationEpoch: 1,
    url: 'https://docs.docker.com/',
    title: 'Docker Docs',
  },
  requestedUrl: 'https://docs.docker.com/',
  url: 'https://docs.docker.com/',
  title: 'Docker Docs',
  text: 'Controlled schema fixture, not a fetched webpage.',
  capturedAt: '2026-10-06T16:00:00.000Z',
  sourceSha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
  extractionVersion: 'rendered-dom-text-v1',
  sourceKind: 'decoded-main-response',
  captureId: '9106578b-e2ce-4c19-a8b7-06753245eaa5',
  screenshotSha256: 'c'.repeat(64),
  truncated: false,
});
const host = () => ({
  page: { webContentsId: 7, documentGeneration: 1, url: 'https://docs.docker.com/', title: 'Docker Docs', partition: 'test:host' },
  requestedUrl: 'https://docs.docker.com/',
  url: 'https://docs.docker.com/',
  title: 'Docker Docs',
  text: 'Legacy host fixture',
  capturedAt: '2026-10-06T16:00:00.000Z',
  sourceSha256: 'a'.repeat(64),
  contentSha256: 'b'.repeat(64),
  extractionVersion: 'html-text-v1',
  truncated: false,
});

describe('strict guest resource provenance', () => {
  it('keeps host records unchanged and preserves guest identity in resources and bundles', () => {
    expect(PageResourceSnapshotSchema.parse(host())).toEqual(host());
    expect(GuestPageResourceSnapshotSchema.parse(guest())).toEqual(guest());
    const resource = { ...guest(), spaceId: 'taskflow-demo', resourceId: '9a8a972a-497c-49fc-a4f0-7ecf45d6c45d', version: 1 };
    const parsed = {
      ...GuestPageResourceSnapshotSchema.parse(guest()),
      spaceId: resource.spaceId,
      resourceId: resource.resourceId,
      version: resource.version,
    };
    expect(parsed).toEqual(resource);
    if (parsed.extractionVersion !== 'rendered-dom-text-v1') throw new Error('Wrong resource source');
    expect(parsed.page.kind).toBe('sandbox-chromium');
    const bundle = ResourceBundleSchema.parse({
      conversationId: 'conv-space-taskflow-demo-impl',
      generation: 'g',
      turnId: 't',
      accountId: 'account',
      workspaceId: 'taskflow-demo',
      sessionId: 'conv-space-taskflow-demo-impl',
      catalogRevision: 1,
      resources: [
        {
          resourceId: resource.resourceId,
          version: 1,
          capturedAt: resource.capturedAt,
          text: resource.text,
          contentSha256: resource.contentSha256,
          sourceSha256: resource.sourceSha256,
          truncated: resource.truncated,
          evidence: { kind: 'web', snapshot: guest() },
        },
      ],
    });
    expect(bundle.resources[0]?.evidence).toEqual({ kind: 'web', snapshot: guest() });
  });
  it('rejects crossed host/guest variants and every unrecognized field', () => {
    for (const candidate of [
      { ...host(), captureId: guest().captureId },
      { ...host(), sourceKind: 'decoded-main-response' },
      { ...host(), screenshotSha256: 'c'.repeat(64) },
      { ...host(), page: guest().page },
      { ...guest(), page: host().page },
      { ...guest(), extractionVersion: 'html-text-v1' },
      { ...guest(), page: { ...guest().page, webContentsId: 1 } },
      { ...guest(), page: { ...guest().page, partition: 'fake-host' } },
      { ...guest(), path: '/tmp/forged' },
    ])
      expect(PageResourceSnapshotSchema.safeParse(candidate).success).toBe(false);
    for (const key of ['sourceKind', 'captureId', 'screenshotSha256']) {
      const candidate: Record<string, unknown> = { ...guest() };
      delete candidate[key];
      expect(PageResourceSnapshotSchema.safeParse(candidate).success).toBe(false);
    }
  });
  it('rejects malformed capture provenance, stale page binding and unsafe URL forms', () => {
    for (const patch of [
      { sourceKind: 'wire-bytes' },
      { captureId: '../capture' },
      { screenshotSha256: 'not-a-digest' },
      { capturedAt: '2026-02-31T12:00:00.000Z' },
      { title: 'Different title' },
      { url: 'https://docs.docker.com/other' },
      { requestedUrl: 'file:///etc/passwd' },
      { requestedUrl: 'https://docs.docker.com:8443/' },
      { requestedUrl: 'https://user:secret@docs.docker.com/' },
      { requestedUrl: 'https://docs.docker.com/\\other' },
      { requestedUrl: ' https://docs.docker.com/' },
      { requestedUrl: 'https://docs.docker.com/\n' },
    ])
      expect(GuestPageResourceSnapshotSchema.safeParse({ ...guest(), ...patch }).success, JSON.stringify(patch)).toBe(false);
    for (const pagePatch of [
      { kind: 'electron' },
      { sandboxName: '../sandbox' },
      { browserInstanceId: 'not-a-uuid' },
      { targetId: '' },
      { targetId: 'a'.repeat(129) },
      { navigationEpoch: -1 },
      { navigationEpoch: 1.5 },
      { navigationEpoch: true },
      { navigationEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { title: 'Different title' },
      { url: 'https://docs.docker.com/other' },
    ])
      expect(GuestPageResourceSnapshotSchema.safeParse({ ...guest(), page: { ...guest().page, ...pagePatch } }).success).toBe(false);
  });
});

describe('host-registered dynamic conversation capability envelope', () => {
  const bundle = {
    conversationId: 'session-7189a675-2a3d-4ede-b5b5-d615c486aa28',
    sessionId: 'session-7189a675-2a3d-4ede-b5b5-d615c486aa28',
    generation: 'generation-1',
    turnId: 'turn-1',
    accountId: 'account',
    workspaceId: 'arbitrary-space',
    catalogRevision: 1,
    resources: [],
  };
  it('accepts dynamic spaces and personal explicit selections', () => {
    expect(ResourceBundleSchema.safeParse(bundle).success).toBe(true);
    expect(
      ResourceBundleSchema.safeParse({
        ...bundle,
        conversationId: 'conv-personal-default',
        sessionId: 'conv-personal-default',
        workspaceId: null,
      }).success,
    ).toBe(true);
  });
  it('rejects crossed session identities and unsafe identity paths', () => {
    expect(ResourceBundleSchema.safeParse({ ...bundle, sessionId: 'another-session' }).success).toBe(false);
    expect(ResourceBundleSchema.safeParse({ ...bundle, conversationId: 'session-../file', sessionId: 'session-../file' }).success).toBe(
      false,
    );
  });
});

describe('UTF-8 byte budget', () => {
  it('counts UTF-8 bytes per code point and lone surrogates as replacement characters', () => {
    const samples: [string, number][] = [
      ['', 0],
      ['ascii', 5],
      ['\u007f\u0080', 3],
      ['\u07ff\u0800', 5],
      ['中文正文', 12],
      ['\uffff', 3],
      ['😀 emoji', 10],
      ['a\ud800', 4],
      ['\udc00b', 4],
      ['\ud800\ud800\udc00', 7],
      ['\ud83d', 3],
    ];
    for (const [value, bytes] of samples) expect(utf8ByteLength(value), JSON.stringify(value)).toBe(bytes);
    expect(utf8ByteLength('正文😀x'.repeat(20000))).toBe(11 * 20000);
  });
});

describe('rendered host browser resource', () => {
  it('permits HTTP identity with an explicit visible-text source and preserves legacy/guest contracts', () => {
    const value = {
      ...host(),
      requestedUrl: 'http://localhost:3210/#hash',
      url: 'http://localhost:3210/#hash',
      page: { ...host().page, url: 'http://localhost:3210/#hash' },
      extractionVersion: 'host-rendered-dom-text-v1',
      sourceKind: 'rendered-visible-text',
    };
    expect(PageResourceSnapshotSchema.safeParse(value).success).toBe(true);
    expect(PageResourceSnapshotSchema.safeParse({ ...value, sourceKind: 'decoded-main-response' }).success).toBe(false);
    expect(PageResourceSnapshotSchema.safeParse({ ...value, url: 'http://user:password@localhost/' }).success).toBe(false);
    expect(PageResourceSnapshotSchema.safeParse(host()).success).toBe(true);
    expect(GuestPageResourceSnapshotSchema.safeParse({ ...guest(), url: 'http://localhost:3210/' }).success).toBe(false);
  });
});
