import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDU_REQUIRED_FILES, type AppImportRequest, type AppProfile } from '@wsl/protocol';
import { AppService } from './app-service';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const files = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx']
  .sort()
  .map((name) => ({ path: name, base64: Buffer.from(name).toString('base64') }));
function request(): AppImportRequest {
  const metadata = files.map((file) => ({
    path: file.path,
    sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
    bytes: Buffer.from(file.base64, 'base64').length,
  }));
  return {
    workspaceId: 'import-space',
    projectId: '128ff490-fde9-40d1-a7ee-0f4b55c2d8a5',
    importOperationId: randomUUID(),
    files,
    source: {
      repository: { commit: 'a'.repeat(40), dirty: false },
      files: metadata,
      sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    },
  };
}
function target(input: AppImportRequest) {
  return { workspaceId: input.workspaceId, projectId: input.projectId, importOperationId: input.importOperationId };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    hold?: boolean;
    publishedBeforeClose?: boolean;
    closeGate?: Promise<void>;
    cleanup?: boolean;
    lostReceipt?: boolean;
    failOnce?: boolean;
    unavailable?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-import-service-'));
  roots.push(root);
  const calls: { operation: string; importOperationId: string; profile?: AppProfile; cancel?: boolean }[] = [];
  const guest = new Map<string, AppProfile>();
  const cancelled = new Set<string>();
  let failed = false;
  let closeCalls = 0;
  let available = !options.unavailable;
  let sandbox: string | null = options.unavailable ? null : 'import-test';
  const connection = {
    runtimeTarget: () => ({ binary: '/configured/sbx', sandbox: 'import-test' }),
    getStatus: () => ({
      available,
      reason: available ? null : 'fixture unavailable',
      sandbox,
      version: 'fixture',
      cwd: '/home/agent/workspace',
    }),
    start: (start: GuestStart, emit: (frame: GuestFrame) => void) => {
      if (start.mode !== 'codex') throw new Error('unexpected mode');
      const input = JSON.parse(start.prompt!) as (typeof calls)[number];
      calls.push(input);
      const done = deferred<GuestOutcome>();
      const reply = (outcome: 'imported' | 'cancelled' | 'failed', retryable = false) => {
        const profile = guest.get(input.importOperationId);
        emit({
          type: 'output',
          stream: 'stdout',
          data:
            'WSL_APP_RESULT:' +
            JSON.stringify({
              importOperationId: input.importOperationId,
              outcome,
              retryable,
              errorCode: outcome === 'failed' ? 'import_copy_failed' : null,
              ...(outcome === 'imported'
                ? { profile, sourceSha256: profile?.projectKind === 'edu-web' ? profile.source.sourceSha256 : undefined }
                : {}),
            }) +
            '\n',
        });
        done.resolve({ confirmed: true, exitCode: 0, error: null });
      };
      queueMicrotask(() => {
        if (input.operation === 'import-source') {
          if (cancelled.has(input.importOperationId)) {
            reply('cancelled');
            return;
          }
          if (options.failOnce && !failed) {
            failed = true;
            reply('failed', true);
            return;
          }
          if (options.hold && !options.publishedBeforeClose) return;
          guest.set(input.importOperationId, input.profile!);
          if (options.hold) return;
          if (options.lostReceipt) {
            done.resolve({ confirmed: true, exitCode: 0, error: null });
            return;
          }
          reply('imported');
        } else if (input.operation === 'reconcile-import') {
          if (guest.has(input.importOperationId)) reply('imported');
          else if (input.cancel) {
            cancelled.add(input.importOperationId);
            reply('cancelled');
          } else reply('failed', true);
        } else throw new Error('unexpected import fixture operation');
      });
      return {
        done: done.promise,
        close: async () => {
          closeCalls++;
          if (options.closeGate) await options.closeGate;
          const result = { confirmed: options.cleanup !== false, exitCode: -15, error: null };
          done.resolve(result);
          return result;
        },
      };
    },
  };
  const registryPath = path.join(root, 'apps.json');
  return {
    root,
    registryPath,
    calls,
    guest,
    cancelled,
    closeCalls: () => closeCalls,
    configure: () => {
      available = true;
      sandbox = 'import-test';
    },
    confirmCleanup: () => {
      options.cleanup = true;
    },
    service: new AppService(connection, { registryPath }),
    restart: () => new AppService(connection, { registryPath }),
  };
}

describe('owned source import service', () => {
  it('publishes once, persists ownership, and treats duplicate confirmation as the same project', async () => {
    const test = await fixture();
    const input = request();
    const first = await test.service.importSource(input);
    expect(first).toMatchObject({
      outcome: 'imported',
      retryable: false,
      errorCode: null,
      app: { state: 'created', cleanupConfirmed: true, profile: { source: input.source } },
    });
    expect(await test.service.importSource(input)).toEqual(first);
    expect(test.calls.map((call) => call.operation)).toEqual(['import-source']);
    expect((await test.restart().importSource(input)).outcome).toBe('imported');
    expect(test.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8')).operations[0].outcome).toBe('imported');
  });
  it('rejects changed identity or provenance for the same operation without another guest call', async () => {
    const test = await fixture();
    const input = request();
    await test.service.importSource(input);
    await expect(test.service.importSource({ ...input, projectId: randomUUID() })).rejects.toThrow('import_operation_conflict');
    await expect(
      test.service.importSource({ ...input, source: { ...input.source, repository: { commit: 'b'.repeat(40), dirty: false } } }),
    ).rejects.toThrow('import_operation_conflict');
    expect(test.calls).toHaveLength(1);
  });
  it('rejects mismatched bytes before any guest or import reservation', async () => {
    const test = await fixture();
    const input = request();
    await expect(test.service.importSource({ ...input, files: [{ ...files[0]!, base64: 'eA==' }, ...files.slice(1)] })).rejects.toThrow(
      'import_input_invalid',
    );
    expect(test.calls).toEqual([]);
  });
  it('persists an early cancel tombstone and refuses a late create even after service restart', async () => {
    const test = await fixture();
    const input = request();
    expect(await test.service.cancelImport(target(input))).toEqual({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    expect((await test.restart().importSource(input)).outcome).toBe('cancelled');
    expect(test.calls.every((call) => call.operation === 'reconcile-import')).toBe(true);
    expect(test.guest.size).toBe(0);
  });
  it('cancellation waits for the original writer to stop before reconciling staging', async () => {
    const gate = deferred<void>();
    const test = await fixture({ hold: true, closeGate: gate.promise });
    const input = request();
    const importing = test.service.importSource(input);
    await vi.waitFor(() => expect(test.calls).toHaveLength(1));
    let settled = false;
    const cancelling = test.service.cancelImport(target(input)).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(test.closeCalls()).toBe(1));
    expect(test.calls).toHaveLength(1);
    expect(settled).toBe(false);
    gate.resolve();
    expect(await cancelling).toEqual({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    expect((await importing).outcome).toBe('cancelled');
    expect(test.calls.map((call) => call.operation)).toEqual(['import-source', 'reconcile-import']);
  });
  it('keeps an already published copy when cancellation wins the response race', async () => {
    const test = await fixture({ hold: true, publishedBeforeClose: true });
    const input = request();
    const importing = test.service.importSource(input);
    await vi.waitFor(() => expect(test.guest.size).toBe(1));
    expect(await test.service.cancelImport(target(input))).toMatchObject({ outcome: 'imported', app: { projectId: input.projectId } });
    expect((await importing).outcome).toBe('imported');
    expect(test.guest.size).toBe(1);
  });
  it('recovers a committed import after its success receipt is lost', async () => {
    const test = await fixture({ lostReceipt: true });
    const input = request();
    expect((await test.service.importSource(input)).outcome).toBe('imported');
    expect(test.calls.map((call) => call.operation)).toEqual(['import-source', 'reconcile-import']);
    expect(test.guest.size).toBe(1);
  });
  it('retries only a cleaned failed operation with the same source and project', async () => {
    const test = await fixture({ failOnce: true });
    const input = request();
    expect(await test.service.importSource(input)).toMatchObject({ outcome: 'failed', retryable: true, app: null });
    expect((await test.service.importSource(input)).outcome).toBe('imported');
    expect(test.guest.size).toBe(1);
    expect(test.calls).toHaveLength(2);
  });
  it('does not reconcile or retry while worker cleanup is unknown', async () => {
    const test = await fixture({ hold: true, cleanup: false });
    const input = request();
    const importing = test.service.importSource(input);
    await vi.waitFor(() => expect(test.calls).toHaveLength(1));
    expect(await test.service.cancelImport(target(input))).toMatchObject({
      outcome: 'failed',
      retryable: false,
      errorCode: 'import_cleanup_unknown',
    });
    await importing;
    expect((await test.service.importSource(input)).retryable).toBe(false);
    expect(test.calls).toHaveLength(1);
  });
  it('does not dispatch copy when the durable reservation cannot be published, and allows a safe retry', async () => {
    const test = await fixture();
    const input = request();
    // Load the journal before making its publication destination a real directory.
    const early = request();
    early.projectId = randomUUID();
    await test.service.cancelImport(target(early));
    await rm(test.registryPath + '.imports.json');
    await mkdir(test.registryPath + '.imports.json');
    const before = test.calls.length;
    expect(await test.service.importSource(input)).toMatchObject({
      outcome: 'failed',
      retryable: true,
      errorCode: 'import_storage_failed',
    });
    expect(test.calls).toHaveLength(before);
    await rm(test.registryPath + '.imports.json', { recursive: true });
    expect((await test.service.importSource(input)).outcome).toBe('imported');
  });
  it('keeps an unconfigured runtime failure safely retryable across setup and service restart', async () => {
    const test = await fixture({ unavailable: true });
    const input = request();
    expect(await test.service.importSource(input)).toEqual({
      app: null,
      outcome: 'failed',
      retryable: true,
      errorCode: 'import_runtime_unavailable',
    });
    expect(test.calls).toEqual([]);
    const journal = JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8'));
    expect(journal).toMatchObject({ sandbox: null, operations: [{ dispatched: false }] });
    test.configure();
    expect((await test.restart().importSource(input)).outcome).toBe('imported');
    expect(test.calls).toHaveLength(1);
  });
  it('persists early cancellation without a runtime and blocks a late request after setup', async () => {
    const test = await fixture({ unavailable: true });
    const input = request();
    expect(await test.service.cancelImport(target(input))).toEqual({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    test.configure();
    expect((await test.restart().importSource(input)).outcome).toBe('cancelled');
    expect(test.calls).toEqual([]);
  });
  it('allows explicit reconciliation after unknown cleanup without replaying the copy', async () => {
    const test = await fixture({ hold: true, cleanup: false });
    const input = request();
    const importing = test.service.importSource(input);
    await vi.waitFor(() => expect(test.calls).toHaveLength(1));
    expect((await test.service.cancelImport(target(input))).errorCode).toBe('import_cleanup_unknown');
    await importing;
    test.confirmCleanup();
    expect((await test.service.cancelImport(target(input))).outcome).toBe('cancelled');
    expect(test.closeCalls()).toBe(2);
    expect(test.calls.map((call) => call.operation)).toEqual(['import-source', 'reconcile-import']);
  });
  it('loads pending ownership before ordinary start or export can bypass it after restart', async () => {
    const test = await fixture();
    const input = request();
    await test.service.importSource(input);
    const journal = JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8'));
    journal.operations[0].outcome = 'pending';
    await writeFile(test.registryPath + '.imports.json', JSON.stringify(journal));
    const restarted = test.restart();
    const key = { workspaceId: input.workspaceId, projectId: input.projectId };
    await expect(restarted.start(key)).rejects.toThrow('import_in_progress');
    await expect(restarted.export(key)).rejects.toThrow('import_in_progress');
    expect(test.calls).toHaveLength(1);
    expect((await restarted.cancelImport(target(input))).outcome).toBe('imported');
    expect(test.calls.map((call) => call.operation)).toEqual(['import-source', 'reconcile-import']);
  });
  it('blocks a standard create from taking an unresolved import reservation after restart', async () => {
    const test = await fixture({ failOnce: true });
    const input = request();
    await test.service.importSource(input);
    await expect(
      test
        .restart()
        .create({ workspaceId: input.workspaceId, projectId: input.projectId, files: [{ path: 'package.json', base64: 'e30=' }] }),
    ).rejects.toThrow('import_in_progress');
    expect(test.calls).toHaveLength(1);
  });
  it('does not leave a phantom reservation when a second operation loses the same-target race', async () => {
    const test = await fixture({ hold: true });
    const input = request();
    const importing = test.service.importSource(input);
    await vi.waitFor(() => expect(test.calls).toHaveLength(1));
    const second = { ...input, importOperationId: randomUUID() };
    await expect(test.service.importSource(second)).rejects.toThrow('import_target_conflict');
    expect((await test.service.cancelImport(target(input))).outcome).toBe('cancelled');
    await importing;
    expect(JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8')).operations).toHaveLength(1);
  });
  it('attempts every import owner during shutdown even if one close remains unknown', async () => {
    const test = await fixture({ hold: true, cleanup: false });
    const first = request();
    const second = { ...request(), projectId: randomUUID() };
    const pending = [test.service.importSource(first), test.service.importSource(second)];
    await vi.waitFor(() => expect(test.calls).toHaveLength(2));
    await expect(test.service.shutdown()).rejects.toThrow('import_cleanup_unknown');
    expect(test.closeCalls()).toBe(2);
    expect((await Promise.all(pending)).every((result) => result.errorCode === 'import_cleanup_unknown')).toBe(true);
  });
  it('restores a guest cancellation tombstone when host cancellation persistence was lost', async () => {
    const test = await fixture({ failOnce: true });
    const input = request();
    await test.service.importSource(input);
    const journal = JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8'));
    journal.operations[0].outcome = 'pending';
    journal.operations[0].cancelRequested = false;
    await writeFile(test.registryPath + '.imports.json', JSON.stringify(journal));
    test.cancelled.add(input.importOperationId);
    const restarted = test.restart();
    expect(await restarted.importSource(input)).toEqual({ app: null, outcome: 'cancelled', retryable: false, errorCode: null });
    expect((await restarted.importSource(input)).outcome).toBe('cancelled');
    expect(test.calls).toHaveLength(2);
    expect(JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8')).operations[0].cancelRequested).toBe(true);
  });
  it('reconciles persisted pending imports during shutdown after the original worker handle was lost', async () => {
    const test = await fixture();
    const input = request();
    await test.service.importSource(input);
    const journal = JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8'));
    journal.operations[0].outcome = 'pending';
    await writeFile(test.registryPath + '.imports.json', JSON.stringify(journal));
    await test.restart().shutdown();
    expect(test.calls.map((call) => call.operation)).toEqual(['import-source', 'reconcile-import']);
    expect(test.guest.size).toBe(1);
    expect(JSON.parse(await readFile(test.registryPath + '.imports.json', 'utf8')).operations[0].outcome).toBe('imported');
  });
});
