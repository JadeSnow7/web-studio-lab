import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCE_CHUNK_BYTES } from '@wsl/protocol';
import { SourceSnapshotReader } from './source-snapshot';
import { AppService, type AppServiceOptions } from './app-service';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  let fail: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return {
    promise,
    reject(reason: Error) {
      if (!fail) throw new Error('uninitialized fixture rejection');
      fail(reason);
    },
    resolve(value: T) {
      if (!complete) throw new Error('uninitialized fixture promise');
      complete(value);
    },
  };
}
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const target = { workspaceId: 'space-source', projectId: 'a33d7ef0-ea73-4fd6-b4a0-e41bd68f1090' };
const wire = (text = 'source\n') =>
  [
    { type: 'file', path: 'src/file.ts', mode: '100644' },
    { type: 'chunk', base64: Buffer.from(text).toString('base64') },
    { type: 'end-file' },
    { type: 'complete', totalBytes: Buffer.byteLength(text), fileCount: 1 },
  ]
    .map((frame) => `WSL_SOURCE:${JSON.stringify(frame)}\n`)
    .join('');

async function fixture(
  options: {
    unknown?: boolean;
    closeError?: boolean;
    timeout?: number;
    closeGate?: Promise<void>;
    closeOutcome?: GuestOutcome;
    onSnapshot?: AppServiceOptions['onSnapshot'];
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-source-service-'));
  temporary.push(root);
  const registryPath = path.join(root, 'apps.json');
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      sandbox: 'fixture',
      apps: [{ ...target, state: 'stopped', cleanupConfirmed: true }],
    }),
  );
  const snapshotDone = deferred<GuestOutcome>();
  const appDone = deferred<GuestOutcome>();
  let sourceOutput: ((frame: GuestFrame) => void) | undefined;
  const sourceClose = vi.fn(async () => {
    if (options.closeGate) await options.closeGate;
    if (options.closeError) throw new Error('close rejected');
    const outcome = options.closeOutcome ?? { confirmed: !options.unknown, exitCode: -15, error: null };
    snapshotDone.resolve(outcome);
    return outcome;
  });
  const appClose = vi.fn(async () => {
    const outcome = { confirmed: true, exitCode: 0, error: null };
    appDone.resolve(outcome);
    return outcome;
  });
  let appInstanceId = '';
  let mapped = false;
  const start = vi.fn((input: GuestStart, onFrame: (frame: GuestFrame) => void) => {
    if (input.mode !== 'codex') throw new Error('unexpected mode');
    const request: unknown = JSON.parse(input.prompt ?? '{}');
    if (!request || typeof request !== 'object' || !('operation' in request)) throw new Error('invalid request');
    if (request.operation === 'source-snapshot' || request.operation === 'apply') {
      sourceOutput = onFrame;
      return { done: snapshotDone.promise, close: sourceClose };
    }
    if (request.operation !== 'start' || !('appInstanceId' in request) || typeof request.appInstanceId !== 'string')
      throw new Error('unexpected operation');
    appInstanceId = request.appInstanceId;
    queueMicrotask(() =>
      onFrame({
        type: 'output',
        stream: 'stdout',
        data:
          JSON.stringify({ event: 'app-ready', port: 4000, identity: { ...target, environmentId: 'sandbox', appInstanceId } }) +
          '\napp-log-only\n',
      }),
    );
    return { done: appDone.promise, close: appClose };
  });
  const service = new AppService(
    {
      start,
      getStatus: () => ({ available: true, sandbox: 'fixture', cwd: '/guest', reason: null, version: 'fixture' }),
      runtimeTarget: () => ({ binary: 'fixture', sandbox: 'fixture' }),
    },
    {
      registryPath,
      onSnapshot: options.onSnapshot,
      sourceSnapshotTimeoutMs: options.timeout ?? 1000,
      ports: async (args) => {
        if (args[0] === '--publish') {
          mapped = true;
          return 'Published 127.0.0.1:49152 -> 4000/tcp4\n';
        }
        if (args[0] === '--unpublish') mapped = false;
        return JSON.stringify(mapped ? [{ host_ip: '127.0.0.1', host_port: 49152, sandbox_port: 4000, protocol: 'tcp4' }] : []);
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            templateId: 'wsl-standard-app',
            templateVersion: '1.1.0',
            identity: { ...target, environmentId: 'sandbox', appInstanceId },
          }),
        ),
    },
  );
  return {
    service,
    start,
    sourceClose,
    appClose,
    appDone,
    snapshotDone,
    output: (text: string) => {
      if (!sourceOutput) throw new Error('source helper not launched');
      sourceOutput({ type: 'output', stream: 'stdout', data: text });
    },
  };
}

describe('bounded raw source snapshot', () => {
  it('assembles split frames, binary chunks and empty files without putting bodies in an App log', () => {
    const reader = new SourceSnapshotReader();
    const data = wire('中文\0binary');
    for (let offset = 0; offset < data.length; offset += 7) reader.accept(data.slice(offset, offset + 7));
    expect(Buffer.from(reader.result(target).files[0]?.base64 ?? '', 'base64').toString()).toBe('中文\0binary');
    const empty = new SourceSnapshotReader();
    empty.accept('WSL_SOURCE:{"type":"complete","fileCount":0,"totalBytes":0}\n');
    expect(empty.result(target).files).toEqual([]);
  });
  it.each([
    'WSL_SOURCE:{"type":"chunk","base64":"YQ=="}\n',
    wire().split('WSL_SOURCE:{"type":"complete"')[0],
    wire().replace('WSL_SOURCE:{"type":"end-file"}', 'WSL_SOURCE:{"type":"chunk","base64":"Yg=="}\nWSL_SOURCE:{"type":"end-file"}'),
    wire().replace('WSL_SOURCE:{"type":"end-file"}\n', ''),
    'WSL_SOURCE:{"type":"end-file"}\n',
    wire().replace('src/file.ts', '../escape'),
    wire().replace('c291cmNlCg==', 'invalid='),
    wire().replace('"totalBytes":7', '"totalBytes":8'),
    wire() + 'unframed\n',
    'x'.repeat(100000),
    'WSL_SOURCE:' + JSON.stringify({ type: 'chunk', base64: Buffer.alloc(SOURCE_CHUNK_BYTES + 1).toString('base64') }) + '\n',
  ])('rejects malformed, oversized, incomplete or reordered transport %#', (data) => {
    if (data === undefined) throw new Error('Missing malformed source fixture');
    const reader = new SourceSnapshotReader();
    expect(() => {
      reader.accept(data);
      reader.result(target);
    }).toThrow();
  });
  it('rejects duplicate and case-colliding files as a whole', () => {
    const reader = new SourceSnapshotReader();
    const data = wire().split('\n').slice(0, 3).join('\n') + '\n';
    reader.accept(data + data.replace('src/file.ts', 'SRC/file.ts') + 'WSL_SOURCE:{"type":"complete","fileCount":2,"totalBytes":14}\n');
    expect(() => reader.result(target)).toThrow('路径');
  });
  it.each([false, true])('collects independently while App running=%s and preserves its log and ownership', async (running) => {
    const f = await fixture();
    await f.service.restore(target);
    if (running) await f.service.start(target);
    const before = f.service.get(target);
    const log = await f.service.logs(target, 65536);
    const capture = f.service.sourceSnapshot(target);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(running ? 2 : 1));
    f.output(wire('private source body'));
    f.snapshotDone.resolve({ confirmed: true, exitCode: 0, error: null });
    const result = await capture;
    expect(result).toMatchObject({ ok: true, cleanupConfirmed: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.workspaceId).toBe(target.workspaceId);
    expect(f.service.get(target)).toEqual(before);
    expect(await f.service.logs(target, 65536)).toEqual(log);
    expect(f.appClose).not.toHaveBeenCalled();
    await f.service.shutdown();
    expect(f.appClose).toHaveBeenCalledTimes(running ? 1 : 0);
  });
  it('cancellation waits for its own helper cleanup, not a promise-only cancellation', async () => {
    const gate = deferred<void>();
    const f = await fixture({ closeGate: gate.promise });
    const controller = new AbortController();
    const capture = f.service.sourceSnapshot(target, controller.signal);
    const rejection = expect(capture).resolves.toMatchObject({ ok: false, cleanupConfirmed: true, error: expect.stringContaining('取消') });
    await vi.waitFor(() => expect(f.start).toHaveBeenCalled());
    controller.abort();
    let ended = false;
    void capture.then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    await vi.waitFor(() => expect(f.sourceClose).toHaveBeenCalled());
    expect(ended).toBe(false);
    gate.resolve();
    await rejection;
    await f.service.shutdown();
  });
  it.each([{ unknown: true }, { closeError: true }])('retains unconfirmed handles across timeout and shutdown: %j', async (options) => {
    const f = await fixture({ ...options, timeout: 5 });
    await expect(f.service.sourceSnapshot(target)).resolves.toMatchObject({
      ok: false,
      cleanupConfirmed: false,
      error: expect.stringContaining('清理未确认'),
    });
    await expect(f.service.sourceSnapshot(target)).resolves.toMatchObject({
      ok: false,
      cleanupConfirmed: false,
      error: expect.stringContaining('上次'),
    });
    await expect(f.service.shutdown()).rejects.toThrow('源码 helper 清理未确认');
  });
  it('shutdown closes only its registered helper and rejects future admission', async () => {
    const f = await fixture();
    const capture = f.service.sourceSnapshot(target);
    const rejection = expect(capture).resolves.toMatchObject({ ok: false, cleanupConfirmed: true, error: expect.stringContaining('关闭') });
    await vi.waitFor(() => expect(f.start).toHaveBeenCalled());
    await f.service.shutdown();
    await rejection;
    expect(f.sourceClose).toHaveBeenCalledOnce();
    await expect(f.service.sourceSnapshot(target)).resolves.toMatchObject({
      ok: false,
      cleanupConfirmed: true,
      error: expect.stringContaining('关闭'),
    });
  });
  it('returns typed owned cleanup facts for an ordinary collector failure, not just an error string', async () => {
    const f = await fixture();
    const capture = f.service.sourceSnapshot(target).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.snapshotDone.resolve({ confirmed: true, exitCode: 1, error: null });
    expect(await capture).toMatchObject({ ok: false, target, cleanupConfirmed: true, error: expect.any(String) });
    await expect(f.service.shutdown()).resolves.toBeUndefined();
  });
  it('returns typed uncertainty and keeps the same owned handle through shutdown', async () => {
    const f = await fixture({ unknown: true, timeout: 5 });
    const result = await f.service.sourceSnapshot(target).catch((error: unknown) => error);
    expect(result).toMatchObject({ ok: false, target, cleanupConfirmed: false, error: expect.any(String) });
    await expect(f.service.shutdown()).rejects.toThrow('清理未确认');
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.sourceClose).toHaveBeenCalledTimes(2);
  });
  it('rejects foreign project identity before starting a helper', async () => {
    const f = await fixture();
    await expect(f.service.sourceSnapshot({ ...target, projectId: randomUUID() })).resolves.toMatchObject({
      ok: false,
      cleanupConfirmed: true,
      error: expect.stringContaining('未创建'),
    });
    expect(f.start).not.toHaveBeenCalled();
  });
  it('uses the fixed standard collector contract without a profile or caller-selected path', async () => {
    const f = await fixture();
    const capturing = f.service.sourceSnapshot(target);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    const request = f.start.mock.calls[0]?.[0];
    if (!request || request.mode !== 'codex') throw new Error('wrong fixture mode');
    expect(request.argv).toEqual(['python3', '-I', '-u', '-c', expect.any(String)]);
    expect(JSON.parse(request.prompt ?? '{}')).toEqual({ operation: 'source-snapshot', ...target });
    f.output(wire());
    f.snapshotDone.resolve({ confirmed: true, exitCode: 0, error: null });
    expect(await capturing).toMatchObject({ ok: true, cleanupConfirmed: true });
    await f.service.shutdown();
  });
  it('retains unknown dispatch when transport throws before returning a collector handle', async () => {
    const f = await fixture();
    f.start.mockImplementation(() => {
      throw new Error('transport lost after dispatch');
    });
    expect(await f.service.sourceSnapshot(target)).toMatchObject({ ok: false, cleanupConfirmed: false });
    expect(await f.service.sourceSnapshot(target)).toMatchObject({ ok: false, cleanupConfirmed: false });
    expect(f.start).toHaveBeenCalledOnce();
    await expect(f.service.shutdown()).rejects.toThrow('清理未确认');
  });
  it('rejects another collector, start and export while its own helper is pending', async () => {
    const f = await fixture();
    const capture = f.service.sourceSnapshot(target);
    try {
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      expect(await f.service.sourceSnapshot(target)).toMatchObject({ ok: false, cleanupConfirmed: false });
      await expect(f.service.start(target)).rejects.toThrow('操作进行中');
      await expect(f.service.export(target)).rejects.toThrow('source_helper_busy');
      expect(f.start).toHaveBeenCalledOnce();
    } finally {
      f.output(wire());
      f.snapshotDone.resolve({ confirmed: true, exitCode: 0, error: null });
      await capture;
      await f.service.shutdown();
    }
  });
  it('does not dispatch when cancellation preceded admission', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.service.sourceSnapshot(target, controller.signal)).toMatchObject({ ok: false, cleanupConfirmed: true });
    expect(f.start).not.toHaveBeenCalled();
    await f.service.shutdown();
  });
  it('retains collector ownership after rejected completion and retries only its own cleanup on shutdown', async () => {
    const f = await fixture();
    const capture = f.service.sourceSnapshot(target);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.snapshotDone.reject(new Error('synthetic done rejection'));
    expect(await capture).toMatchObject({ ok: false, cleanupConfirmed: false });
    expect(await f.service.sourceSnapshot(target)).toMatchObject({ ok: false, cleanupConfirmed: false });
    expect(f.sourceClose).not.toHaveBeenCalled();
    await f.service.shutdown();
    expect(f.sourceClose).toHaveBeenCalledOnce();
    expect(f.appClose).not.toHaveBeenCalled();
  });
  it('ignores late frames once the completed collector no longer owns admission', async () => {
    const f = await fixture();
    const capture = f.service.sourceSnapshot(target);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    f.output(wire());
    f.snapshotDone.resolve({ confirmed: true, exitCode: 0, error: null });
    const result = await capture;
    f.output('late-invalid-frame\n');
    expect(result).toMatchObject({ ok: true, cleanupConfirmed: true });
    expect(f.sourceClose).not.toHaveBeenCalled();
    await f.service.start(target);
    expect(f.service.get(target).state).toBe('running');
    await f.service.shutdown();
  });
  it('refuses source collection during the App exit completion publisher window', async () => {
    const gate = deferred<void>();
    let publishing = false;
    const f = await fixture({
      onSnapshot: async (snapshot) => {
        if (snapshot.state === 'failed' && !publishing) {
          publishing = true;
          await gate.promise;
        }
      },
    });
    try {
      await f.service.start(target);
      f.appDone.resolve({ confirmed: true, exitCode: 1, error: 'synthetic app exit' });
      await vi.waitFor(() => expect(publishing).toBe(true));
      expect(await f.service.sourceSnapshot(target)).toMatchObject({
        ok: false,
        cleanupConfirmed: true,
        error: expect.stringContaining('有限 helper'),
      });
      expect(f.start).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await expect(f.service.shutdown()).rejects.toThrow('沙箱映射连续性未知');
      expect(f.service.get(target)).toMatchObject({ state: 'failed', cleanupConfirmed: false });
      expect(f.appClose).toHaveBeenCalledOnce();
    }
  });
});

describe('source apply committed receipt ownership', () => {
  const files = [{ path: 'src/file.ts', base64: Buffer.from('written\n').toString('base64') }];
  it.each(['before-abort', 'after-abort'] as const)('preserves a committed receipt %s until cleanup confirms', async (timing) => {
    const release = deferred<void>();
    const f = await fixture({ closeGate: release.promise, closeOutcome: { confirmed: true, exitCode: 0, error: null } });
    const controller = new AbortController();
    const applying = f.service.sourceApply(target, files, controller.signal);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    if (timing === 'before-abort') f.output('WSL_APP_RESULT:{"applied":true}\n');
    controller.abort();
    await vi.waitFor(() => expect(f.sourceClose).toHaveBeenCalledOnce());
    if (timing === 'after-abort') f.output('WSL_APP_RESULT:{"applied":true}\n');
    release.resolve();
    expect(await applying).toEqual({ ok: true, target, cleanupConfirmed: true });
    await f.service.shutdown();
  });
  it.each(['missing', 'invalid', 'not-applied', 'negative-cleanup', 'exit-failed'] as const)(
    'does not promote %s into a committed write',
    async (kind) => {
      const release = deferred<void>();
      const confirmed = kind !== 'negative-cleanup';
      const f = await fixture({
        closeGate: release.promise,
        closeOutcome: { confirmed, exitCode: kind === 'exit-failed' ? 2 : 0, error: null },
      });
      const controller = new AbortController();
      const applying = f.service.sourceApply(target, files, controller.signal);
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      controller.abort();
      if (kind !== 'missing')
        f.output(
          kind === 'invalid'
            ? 'WSL_APP_RESULT:{broken\n'
            : kind === 'not-applied'
              ? 'WSL_APP_RESULT:{"applied":false}\n'
              : 'WSL_APP_RESULT:{"applied":true}\n',
        );
      release.resolve();
      expect(await applying).toMatchObject({ ok: false, cleanupConfirmed: confirmed });
      if (confirmed) await f.service.shutdown();
      else await expect(f.service.shutdown()).rejects.toThrow(/清理未确认/);
    },
  );
});

it('service shutdown keeps an in-flight committed source apply receipt visible until cleanup confirms', async () => {
  const release = deferred<void>();
  const f = await fixture({ closeGate: release.promise, closeOutcome: { confirmed: true, exitCode: 0, error: null } });
  const applying = f.service.sourceApply(target, [{ path: 'src/file.ts', base64: 'eA==' }]);
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  const shutdown = f.service.shutdown();
  await vi.waitFor(() => expect(f.sourceClose).toHaveBeenCalledOnce());
  f.output('WSL_APP_RESULT:{"applied":true}\n');
  release.resolve();
  expect(await applying).toEqual({ ok: true, target, cleanupConfirmed: true });
  await shutdown;
});
it('source apply does not dispatch if cancellation preceded admission', async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  expect(await f.service.sourceApply(target, [{ path: 'src/file.ts', base64: 'eA==' }], controller.signal)).toMatchObject({
    ok: false,
    cleanupConfirmed: true,
  });
  expect(f.start).not.toHaveBeenCalled();
  await f.service.shutdown();
});
