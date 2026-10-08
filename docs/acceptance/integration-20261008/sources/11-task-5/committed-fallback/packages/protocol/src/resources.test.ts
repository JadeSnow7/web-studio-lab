import { describe, expect, it } from 'vitest';
import {
  GuestPageResourceSnapshotSchema,
  PageResourceSnapshotSchema,
  ResourceBundleSchema,
  SpaceResourceSchema,
  type GuestPageResourceSnapshot,
} from './resources';

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
    const parsed = SpaceResourceSchema.parse(resource);
    expect(parsed).toEqual(resource);
    if (parsed.extractionVersion !== 'rendered-dom-text-v1') throw new Error('Wrong resource source');
    expect(parsed.page.kind).toBe('sandbox-chromium');
    const bundle = ResourceBundleSchema.parse({
      conversationId: 'conv-space-taskflow-demo-impl',
      generation: 'g',
      turnId: 't',
      spaceId: 'taskflow-demo',
      collectionRevision: 1,
      resources: [resource],
    });
    expect(bundle.resources[0]).toEqual(resource);
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
