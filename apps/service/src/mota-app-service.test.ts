import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOTA_REQUIRED_FILES,
  MotaEditorFrameSchema,
  motaSourceIdentityInput,
  type AppProfile,
  type MotaAppImportRequest,
} from '@wsl/protocol';
import { AppService } from './app-service';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function request(): MotaAppImportRequest {
  const files = MOTA_REQUIRED_FILES.map((name) => ({
    path: name,
    base64: Buffer.from(name === 'main.js' ? 'x'.repeat(70000) : name).toString('base64'),
  }));
  const metadata = files
    .map((file) => ({
      path: file.path,
      sha256: digest(Buffer.from(file.base64, 'base64')),
      bytes: Buffer.from(file.base64, 'base64').length,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    profile: 'mota-web',
    workspaceId: 'mota-space',
    projectId: randomUUID(),
    importOperationId: randomUUID(),
    source: { sourceSha256: digest(motaSourceIdentityInput(metadata)), files: metadata },
    files,
  };
}
function key(input: MotaAppImportRequest) {
  return { workspaceId: input.workspaceId, projectId: input.projectId };
}
function target(input: MotaAppImportRequest) {
  return { workspaceId: input.workspaceId, projectId: input.projectId, importOperationId: input.importOperationId };
}
async function fixture(
  options: {
    wrongBind?: boolean;
    wrongListening?: boolean;
    protectedChanged?: boolean;
    cleanupUnknown?: boolean;
    holdChunk?: boolean;
    lostReceipt?: boolean;
    exitDuringPublish?: boolean;
    wrongEditor?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-mota-service-'));
  roots.push(root);
  const registryPath = path.join(root, 'apps.json');
  let published = false;
  let bound = false;
  let copied = false;
  let profile: AppProfile | null = null;
  let currentInput: MotaAppImportRequest | null = null;
  let identity: Record<string, unknown> = {};
  let starts = 0;
  let closes = 0;
  let exitApp: (() => void) | undefined;
  const events: string[] = [];
  const startsInput: Extract<GuestStart, { mode: 'codex' }>[] = [];
  const frames: Record<string, unknown>[] = [];
  const connection = {
    getStatus: () => ({ available: true, reason: null, sandbox: 'mota-test', version: 'fixture', cwd: '/home/agent/workspace' }),
    runtimeTarget: () => ({ binary: '/configured/sbx', sandbox: 'mota-test' }),
    start: (start: GuestStart, emit: (frame: GuestFrame) => void) => {
      if (start.mode !== 'codex') throw new Error('unexpected mode');
      startsInput.push(start);
      starts++;
      const initial = JSON.parse(start.prompt ?? '{}');
      let resolve!: (value: GuestOutcome) => void;
      const done = new Promise<GuestOutcome>((finish) => {
        resolve = finish;
      });
      const reply = (data: unknown, prefix = '') => emit({ type: 'output', stream: 'stdout', data: prefix + JSON.stringify(data) + '\n' });
      const finish = () => resolve({ confirmed: true, exitCode: 0, error: null });
      const input = (frame: {
        type: string;
        binding: unknown;
        seq: number;
        fileIndex: number;
        offset: number;
        base64: string;
        bytes: number;
        sha256: string;
        fileCount: number;
        totalBytes: number;
        sourceSha256: string;
        requestId: string;
        origin: string;
        identity: unknown;
        method?: string;
      }) => {
        frames.push(frame);
        if (frame.type === 'mota-editor') {
          const { input: _input, ...envelope } = MotaEditorFrameSchema.parse(frame);
          reply({
            ...envelope,
            type: 'mota-editor-result',
            ok: true,
            ...(options.wrongEditor ? { editorSessionId: randomUUID() } : {}),
            data: frame.method === 'editor.revoke' ? { discarded: false, settled: true, operation: null } : { settled: true },
          });
          return;
        }
        if (frame.type === 'mota-control') {
          reply({
            type: 'mota-control-result',
            requestId: frame.requestId,
            binding: frame.binding,
            method: frame.method,
            ok: true,
            data: { settled: true },
          });
          return;
        }
        if (frame.type === 'bind-origin') {
          bound = true;
          events.push('bind');
          reply({
            event: 'mota-origin-bound',
            requestId: frame.requestId,
            origin: options.wrongBind ? 'http://127.0.0.1:1' : frame.origin,
            identity: frame.identity,
          });
          return;
        }
        if (frame.type === 'chunk' && options.holdChunk) return;
        if (frame.type === 'finish') {
          copied = true;
          events.push('publish-copy');
          profile = { projectKind: 'mota-web', profileVersion: 1, source: currentInput!.source };
          if (options.lostReceipt) {
            finish();
            return;
          }
          reply(
            {
              type: 'receipt',
              binding: frame.binding,
              seq: frame.seq,
              outcome: 'imported',
              fileCount: frame.fileCount,
              totalBytes: frame.totalBytes,
              sourceSha256: frame.sourceSha256,
            },
            'WSL_MOTA_TRANSFER:',
          );
          return;
        }
        reply(
          {
            type: 'ack',
            binding: frame.binding,
            seq: frame.seq,
            operation: frame.type,
            fileIndex: frame.type === 'begin' ? null : frame.fileIndex,
            offset:
              frame.type === 'chunk'
                ? frame.offset + Buffer.from(frame.base64, 'base64').length
                : frame.type === 'file-end'
                  ? frame.bytes
                  : 0,
            sha256: frame.type === 'file' || frame.type === 'file-end' ? frame.sha256 : null,
          },
          'WSL_MOTA_TRANSFER:',
        );
      };
      queueMicrotask(() => {
        if (initial.type === 'begin') {
          input(initial);
          return;
        }
        if (initial.operation === 'reconcile-import') {
          events.push('reconcile');
          reply(
            {
              importOperationId: initial.importOperationId,
              outcome: copied ? 'imported' : 'cancelled',
              retryable: false,
              errorCode: null,
              ...(copied ? { profile, sourceSha256: currentInput!.source.sourceSha256 } : {}),
            },
            'WSL_APP_RESULT:',
          );
          finish();
          return;
        }
        if (initial.operation !== 'start') throw new Error('unexpected app command');
        events.push('start');
        exitApp = () => {
          emit({ type: 'output', stream: 'stderr', data: 'mota-server:bind_timeout\n' });
          resolve({ confirmed: true, exitCode: 1, error: null });
        };
        bound = false;
        identity = {
          workspaceId: initial.workspaceId,
          environmentId: 'sandbox',
          projectId: initial.projectId,
          appInstanceId: initial.appInstanceId,
        };
        if (options.protectedChanged) {
          finish();
          return;
        }
        emit({ type: 'output', stream: 'stdout', data: 'WSL_APP_SOURCE:' + initial.profile.source.sourceSha256 + '\n' });
        reply({
          event: 'mota-listening',
          guestPort: 43187,
          identity: { ...identity, ...(options.wrongListening ? { appInstanceId: randomUUID() } : {}) },
        });
      });
      return {
        done,
        write: (frame: { type: 'input'; data: string }) => input(JSON.parse(frame.data)),
        closeInput: () => {
          events.push('input-closed');
          finish();
        },
        close: async () => {
          closes++;
          events.push('close');
          const result = { confirmed: !options.cleanupUnknown, exitCode: 0, error: null };
          resolve(result);
          return result;
        },
      };
    },
  };
  const ports = vi.fn(async (args: string[]) => {
    if (args[0] === '--publish') {
      published = true;
      events.push('publish-port');
      if (options.exitDuringPublish) exitApp?.();
      return 'Published 127.0.0.1:49152 -> 43187/tcp4';
    }
    if (args[0] === '--unpublish') {
      published = false;
      events.push('unpublish');
      return '';
    }
    return JSON.stringify({ ports: published ? [{ host_ip: '127.0.0.1', host_port: 49152, sandbox_port: 43187, protocol: 'tcp4' }] : [] });
  });
  const health = vi.fn(async () => {
    events.push('health');
    if (!bound) throw new Error('health before origin binding');
    return new Response(JSON.stringify({ ok: true, templateId: 'mota-web', templateVersion: '1.0.0', identity }), { status: 200 });
  });
  const service = new AppService(connection, { registryPath, ports, fetch: health, startupTimeoutMs: 500 });
  return {
    service,
    registryPath,
    events,
    frames,
    startsInput,
    starts: () => starts,
    closes: () => closes,
    ports,
    health,
    import: (value: MotaAppImportRequest) => {
      currentInput = value;
      return service.importSource(value);
    },
    copyPublished: () => copied,
    setChanged: () => {
      options.protectedChanged = true;
    },
  };
}

describe('Mota managed service integration', () => {
  it.each([false, true])('dispatches manual frames before startup fallback and checks the owned reply (wrong=%s)', async (wrongEditor) => {
    const input = request();
    const f = await fixture({ wrongEditor });
    await f.import(input);
    const app = await f.service.start(key(input));
    const binding = {
      ...key(input),
      environmentId: 'sandbox' as const,
      appInstanceId: app.appInstanceId!,
      resourceId: 'editor',
      resourceInstanceId: randomUUID(),
      resourceGeneration: 1,
      browserInstanceId: randomUUID(),
      browserGeneration: 1,
      documentGeneration: 1,
      editorEpoch: 1,
    };
    const open = { binding, editorSessionId: randomUUID(), requestId: randomUUID(), method: 'editor.open' as const, input: {} };
    expect(await f.service.motaEditor(open)).toMatchObject(wrongEditor ? { ok: false, error: { code: 'invalid_frame' } } : { ok: true });
    expect(f.frames.filter((frame) => frame.type === 'mota-editor')).toHaveLength(1);
    expect(() => f.service.motaEditor({ ...open, binding: { ...binding, appInstanceId: randomUUID() } })).toThrow('unavailable');
    expect((await f.service.stop(key(input))).cleanupConfirmed).toBe(true);
    expect(() => f.service.motaEditor(open)).toThrow('unavailable');
    const next = await f.service.start(key(input));
    expect(next.appInstanceId).not.toBe(app.appInstanceId);
    expect(() => f.service.motaEditor(open)).toThrow('unavailable');
    await f.service.stop(key(input));
  });
  it('streams bounded chunks, journals versioned source and starts only after exact origin acknowledgement', async () => {
    const input = request();
    const f = await fixture();
    expect(await f.import(input)).toMatchObject({
      outcome: 'imported',
      app: { profile: { projectKind: 'mota-web' }, sourceSha256: input.source.sourceSha256 },
    });
    expect(f.startsInput[0]).toMatchObject({ duplex: true });
    expect(f.startsInput[0]!.mode === 'codex' && Buffer.byteLength(f.startsInput[0]!.argv.join(' '))).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(f.startsInput[0]!.prompt!)).toBeLessThan(1024);
    expect(
      f.frames.filter((frame) => frame.type === 'chunk').every((frame) => Buffer.from(frame.base64 as string, 'base64').length <= 32768),
    ).toBe(true);
    expect(JSON.parse(await readFile(f.registryPath + '.imports.json', 'utf8'))).toMatchObject({
      version: 2,
      operations: [{ profileKind: 'mota-web', source: input.source, published: true }],
    });
    const started = await f.service.start(key(input));
    expect(started).toMatchObject({ state: 'running', url: 'http://127.0.0.1:49152', cleanupConfirmed: false });
    expect(JSON.parse(f.startsInput.at(-1)!.prompt!)).not.toHaveProperty('agentToken');
    expect(f.events.indexOf('publish-port')).toBeLessThan(f.events.indexOf('bind'));
    expect(f.events.indexOf('bind')).toBeLessThan(f.events.indexOf('health'));
    expect(await f.service.stop(key(input))).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    expect(f.events.indexOf('unpublish')).toBeLessThan(f.events.lastIndexOf('close'));
    expect((await f.service.start(key(input))).state).toBe('running');
    await f.service.stop(key(input));
  });
  it.each(['wrongBind', 'wrongListening'] as const)('fails closed on %s and removes only its mapping', async (option) => {
    const input = request();
    const f = await fixture({ [option]: true });
    await f.import(input);
    expect(await f.service.start(key(input))).toMatchObject({ state: 'failed', cleanupConfirmed: true, url: null });
    expect(f.health).not.toHaveBeenCalled();
    expect(f.ports.mock.calls.filter(([args]) => args[0] === '--unpublish')).toHaveLength(option === 'wrongBind' ? 1 : 0);
  });
  it('records a published mapping but never binds after the new child exits during publication', async () => {
    const input = request();
    const f = await fixture({ exitDuringPublish: true });
    await f.import(input);
    const failed = await f.service.start(key(input));
    expect(failed).toMatchObject({ state: 'failed', cleanupConfirmed: false, url: null });
    expect(failed.error).toContain('exitCode=1');
    expect(failed.error).toContain('mota-server:bind_timeout');
    expect(failed.error).toContain('沙箱映射连续性未知');
    expect(f.frames.some((frame) => frame.type === 'bind-origin')).toBe(false);
    expect(f.health).not.toHaveBeenCalled();
    expect(f.ports.mock.calls.filter(([args]) => args[0] === '--unpublish')).toHaveLength(0);
    expect(await f.service.inspectRecovery(key(input))).toMatchObject({
      cleanupConfirmed: false,
      portPending: true,
      port: { host_ip: '127.0.0.1', host_port: 49152, sandbox_port: 43187, protocol: 'tcp4' },
    });
    const registry = JSON.parse(await readFile(f.registryPath, 'utf8'));
    expect(registry.apps[0]).toMatchObject({
      state: 'failed',
      cleanupConfirmed: false,
      portPending: true,
      port: { host_ip: '127.0.0.1', host_port: 49152, sandbox_port: 43187, protocol: 'tcp4' },
    });
    await expect(f.service.start(key(input))).rejects.toThrow('清理尚未确认');
  });
  it('retains process uncertainty after failed cleanup and forbids restart', async () => {
    const input = request();
    const f = await fixture({ wrongBind: true, cleanupUnknown: true });
    await f.import(input);
    expect(await f.service.start(key(input))).toMatchObject({ state: 'failed', cleanupConfirmed: false });
    await expect(f.service.start(key(input))).rejects.toThrow();
  });
  it('rejects altered source hashes before dispatch and protected assets before republishing a port', async () => {
    const input = request();
    const f = await fixture();
    const corrupt = structuredClone(input);
    corrupt.files[0]!.base64 = Buffer.from('changed').toString('base64');
    await expect(f.import(corrupt)).rejects.toThrow('import_input_invalid');
    expect(f.starts()).toBe(0);
    await f.import(input);
    await f.service.start(key(input));
    await f.service.stop(key(input));
    f.setChanged();
    const before = f.ports.mock.calls.filter(([args]) => args[0] === '--publish').length;
    expect((await f.service.start(key(input))).state).toBe('failed');
    expect(f.ports.mock.calls.filter(([args]) => args[0] === '--publish')).toHaveLength(before);
  });
  it('denies standard controls, export, task snapshots and same-project AI admission without launching helpers', async () => {
    const input = request();
    const f = await fixture();
    await f.import(input);
    const before = f.starts();
    await expect(f.service.export(key(input))).rejects.toThrow('unsupported');
    expect(await f.service.sourceSnapshot(key(input))).toMatchObject({ ok: false, cleanupConfirmed: true });
    expect(await f.service.agent(key(input), null, { op: 'describe' }, new AbortController().signal)).toMatchObject({
      operationDispatched: false,
      envelope: { ok: false, error: { code: 'unsupported' } },
    });
    await expect(f.service.assertTaskAdmission(input.workspaceId)).rejects.toThrow('mota-web');
    expect(f.starts()).toBe(before);
  });
  it('requires a live exact Mota binding and holds lifecycle until an explicit lease release', async () => {
    const input = request();
    const f = await fixture();
    await f.import(input);
    const app = await f.service.start(key(input));
    const binding = {
      ...key(input),
      environmentId: 'sandbox' as const,
      appInstanceId: app.appInstanceId!,
      runId: randomUUID(),
      sessionId: 'session',
      resourceId: 'game',
      browserInstanceId: 'browser',
      browserGeneration: 0,
      webContentsId: 1,
      documentGeneration: 0,
    };
    f.service.registerMotaTask(binding);
    await expect(f.service.assertTaskAdmission(input.workspaceId, undefined, binding)).resolves.toBeUndefined();
    await expect(f.service.assertTaskAdmission(input.workspaceId, undefined, { ...binding, appInstanceId: randomUUID() })).rejects.toThrow(
      'live app lease',
    );
    const result = await f.service.motaControl({ type: 'mota-control', requestId: randomUUID(), binding, method: 'acquire', input: {} });
    expect(result).toMatchObject({ method: 'acquire', ok: true });
    f.service.assertMotaTaskActive(binding);
    await expect(f.service.stop(key(input))).rejects.toThrow('租约尚未释放');
    await expect(f.service.start(key(input))).rejects.toThrow('租约尚未释放');
    expect(
      await f.service.motaControl({ type: 'mota-control', requestId: randomUUID(), binding, method: 'release', input: {} }),
    ).toMatchObject({ ok: true });
    expect((await f.service.stop(key(input))).cleanupConfirmed).toBe(true);
  });
  it('cancels a waiting chunk, confirms helper cleanup, writes tombstone and never publishes', async () => {
    const input = request();
    const f = await fixture({ holdChunk: true });
    const importing = f.import(input);
    await vi.waitFor(() => expect(f.frames.some((frame) => frame.type === 'chunk')).toBe(true));
    const cancelling = f.service.cancelImport(target(input));
    expect(await importing).toMatchObject({ outcome: 'cancelled', app: null });
    expect(await cancelling).toMatchObject({ outcome: 'cancelled' });
    expect(f.copyPublished()).toBe(false);
    expect(f.closes()).toBe(1);
    const before = f.starts();
    expect((await f.import(input)).outcome).toBe('cancelled');
    expect(f.starts()).toBe(before);
  });
  it('reconciles committed import after receipt loss instead of copying again', async () => {
    const input = request();
    const f = await fixture({ lostReceipt: true });
    expect(await f.import(input)).toMatchObject({ outcome: 'imported', app: { profile: { source: input.source } } });
    expect(f.frames.filter((frame) => frame.type === 'begin')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'reconcile')).toHaveLength(1);
  });
  it('migrates legacy cancellation records without losing bytes or allowing late imports', async () => {
    const input = request();
    const f = await fixture();
    const old = JSON.stringify({
      version: 1,
      sandbox: 'mota-test',
      operations: [
        {
          ...target(input),
          source: null,
          outcome: 'cancelled',
          retryable: false,
          errorCode: null,
          cancelRequested: true,
          published: false,
          dispatched: true,
        },
      ],
    });
    await writeFile(f.registryPath + '.imports.json', old);
    expect((await f.import(input)).outcome).toBe('cancelled');
    expect(f.starts()).toBe(0);
    // A second operation triggers the journal upgrade, retaining the legacy tombstone.
    const second = request();
    expect((await f.import(second)).outcome).toBe('imported');
    expect(await readFile(f.registryPath + '.imports.json.schema-v1.json', 'utf8')).toBe(old);
    expect(JSON.parse(await readFile(f.registryPath + '.imports.json', 'utf8')).operations).toHaveLength(2);
  });
});
