import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GUEST_BROWSER_SANDBOX, GUEST_BROWSER_URL, GuestBrowserRequestSchema, type GuestBrowserSuccess } from '@wsl/protocol';
import { ResourceStore } from './resource-store';
import { assertGuestSandboxIdentity, saveGuestCapture, validateGuestCapture } from './guest-browser-bridge';

const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const request = GuestBrowserRequestSchema.parse({
  operation: 'capture',
  url: GUEST_BROWSER_URL,
  sandboxName: GUEST_BROWSER_SANDBOX,
  captureId: randomUUID(),
});
// 仅供宿主边界测试的合成帧；不作为真实浏览器、截图或资源验收证据。
function fixture(): GuestBrowserSuccess {
  const png = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  const digest = sha(png);
  return {
    protocolVersion: 1,
    ok: true,
    snapshot: {
      extractionVersion: 'rendered-dom-text-v1',
      sourceKind: 'decoded-main-response',
      captureId: request.captureId,
      screenshotSha256: digest,
      requestedUrl: request.url,
      url: request.url,
      title: 'OFFLINE SYNTHETIC FIXTURE',
      text: 'OFFLINE SYNTHETIC FIXTURE',
      capturedAt: '2026-10-06T16:00:00.000Z',
      sourceSha256: 'a'.repeat(64),
      contentSha256: sha('OFFLINE SYNTHETIC FIXTURE'),
      truncated: false,
      page: {
        kind: 'sandbox-chromium',
        sandboxName: request.sandboxName,
        browserInstanceId: randomUUID(),
        targetId: 'offline-target',
        navigationEpoch: 1,
        url: request.url,
        title: 'OFFLINE SYNTHETIC FIXTURE',
      },
    },
    screenshot: { mimeType: 'image/png', base64: png.toString('base64'), sha256: digest, bytes: png.length },
    evidence: {
      guest: { platform: 'linux', architecture: 'arm64', uid: 1000, nodeVersion: 'v24.21.0' },
      launch: {
        chromiumSandbox: true,
        debuggingPipe: true,
        noSandboxFlag: false,
        browserPid: 100,
        browserVersion: '153.0.8010.12',
        executable: '/synthetic/chrome',
        elf: true,
      },
      sandbox: {
        diagnostic: { namespaceSandbox: true, pidNamespaces: true, seccompBpf: true },
        browser: { pid: 100, seccomp: 0, seccompFilters: 0, noNewPrivs: 0, pidNamespace: 'pid:[1]', userNamespace: 'user:[1]' },
        renderers: [{ pid: 101, seccomp: 2, seccompFilters: 1, noNewPrivs: 1, pidNamespace: 'pid:[2]', userNamespace: 'user:[2]' }],
      },
    },
    network: { totalRequests: 1, blocked: [], failed: [] },
    cleanup: { browserClosed: true },
  };
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('guest browser host boundary (offline synthetic frames)', () => {
  it('requires explicit startup authorization and refuses mounts or another sandbox', () => {
    const stopped = { name: GUEST_BROWSER_SANDBOX, agent: 'codex', state: 'stopped', runtime_mounts: [] };
    expect(() => assertGuestSandboxIdentity(stopped)).toThrow('sandbox');
    expect(() => assertGuestSandboxIdentity(stopped, true)).not.toThrow();
    expect(() => assertGuestSandboxIdentity({ ...stopped, runtime_mounts: ['/host'] }, true)).toThrow();
    expect(() => assertGuestSandboxIdentity({ ...stopped, name: 'other' }, true)).toThrow();
  });
  it('rejects arbitrary URLs, sandbox names and command parameters', () => {
    for (const delta of [{ url: 'https://example.com/' }, { sandboxName: 'another' }, { command: 'id' }, { path: '/etc/passwd' }]) {
      expect(() => GuestBrowserRequestSchema.parse({ ...request, ...delta })).toThrow();
    }
  });
  it('rejects body, identity, screenshot and sandbox-proof substitutions', () => {
    const mutations: Array<(result: GuestBrowserSuccess) => void> = [
      (r) => {
        r.snapshot.text = 'tampered';
      },
      (r) => {
        r.snapshot.captureId = randomUUID();
      },
      (r) => {
        r.snapshot.page.sandboxName = 'other';
      },
      (r) => {
        r.screenshot.base64 += 'AAAA';
      },
      (r) => {
        r.snapshot.screenshotSha256 = 'b'.repeat(64);
      },
      (r) => {
        r.evidence.sandbox.renderers[0]!.seccomp = 0;
      },
      (r) => {
        r.evidence.sandbox.renderers[0]!.pidNamespace = r.evidence.sandbox.browser.pidNamespace;
      },
      (r) => {
        r.evidence.launch.browserPid = 999;
      },
      (r) => {
        r.cleanup.browserClosed = false;
      },
    ];
    mutations.push((r) => {
      r.evidence.sandbox.browser.seccompFilters = r.evidence.sandbox.renderers[0]!.seccompFilters;
    });
    for (const mutate of mutations) {
      const result = fixture();
      mutate(result);
      expect(() => validateGuestCapture(result, request)).toThrow();
    }
  });
  it('rejects unknown result fields and accepts a bounded explicit dependency failure', () => {
    expect(() => validateGuestCapture({ ...fixture(), arbitrary: true }, request)).toThrow();
    const failure = {
      protocolVersion: 1,
      ok: false,
      error: { code: 'MISSING_PLAYWRIGHT', message: 'missing' },
      cleanup: { browserClosed: true },
    };
    expect(validateGuestCapture(failure, request)).toEqual(failure);
  });
  it('preserves exact guest provenance and binds an independent artifact to the stored version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-guest-store-'));
    roots.push(root);
    const store = new ResourceStore(path.join(root, 'space'));
    const result = fixture();
    const saved = await saveGuestCapture(store, path.join(root, 'artifacts'), result);
    expect(saved.resource.version).toBe(1);
    expect(saved.resource.page).toEqual(result.snapshot.page);
    expect(sha(await readFile(saved.screenshotArtifact))).toBe(result.snapshot.screenshotSha256);
    expect(JSON.stringify(saved.collection)).not.toContain(result.screenshot.base64);
    expect((await saveGuestCapture(store, path.join(root, 'artifacts'), result)).collection.revision).toBe(1);
    expect((await store.list('taskflow-demo')).resources[0]).toEqual(saved.resource);
  });
});
