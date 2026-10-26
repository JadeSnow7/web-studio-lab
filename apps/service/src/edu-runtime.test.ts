import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EDU_REQUIRED_FILES, type AppImportRequest, type AppProfile } from '@wsl/protocol';
import { AppService } from './app-service';
import type { GuestFrame, GuestOutcome, GuestStart } from './sbx';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const files = [...EDU_REQUIRED_FILES, 'admin/src/App.tsx']
  .sort()
  .map((name) => ({ path: name, base64: Buffer.from(name).toString('base64') }));
const metadata = files.map((file) => ({
  path: file.path,
  sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
  bytes: Buffer.from(file.base64, 'base64').length,
}));
const source = {
  repository: { commit: 'a'.repeat(40), dirty: false },
  files: metadata,
  sourceSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
};
const profile: AppProfile = { projectKind: 'edu-web', profileVersion: 1, source };
const key = { workspaceId: 'edu-runtime', projectId: '26ab1fdc-029e-4c01-8138-a2eec271b454' };

type Request = {
  operation: string;
  appInstanceId?: string;
  importOperationId?: string;
  owner?: { identity: Record<string, unknown>; sourceSha256: string };
  profile?: AppProfile;
};
async function fixture(
  settings: {
    badHealth?: boolean;
    omitSource?: boolean;
    duplicateSource?: boolean;
    sourceDigestMismatch?: boolean;
    keeperFails?: boolean;
    mappingChanged?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-runtime-'));
  const registryPath = path.join(root, 'registry.json');
  let currentFiles = files.map((file) => ({ ...file }));
  const currentHash = () =>
    createHash('sha256')
      .update(
        JSON.stringify(
          currentFiles.map((file) => ({
            path: file.path,
            sha256: createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'),
            bytes: Buffer.from(file.base64, 'base64').length,
          })),
        ),
      )
      .digest('hex');
  const owners = new Map<string, { identity: Record<string, unknown>; sourceSha256: string }>();
  const starts: Array<{ start: GuestStart; request: Request }> = [];
  const children: Array<() => void> = [];
  const commands: string[][] = [];
  let identity: Record<string, unknown> = {};
  let mapping = false;
  const connection = {
    getStatus: () => ({ available: true, reason: null, sandbox: 'edu-runtime-test', version: 'fixture', cwd: '/home/agent/workspace' }),
    runtimeTarget: () => ({ binary: '/unused/sbx', sandbox: 'edu-runtime-test' }),
    start(start: GuestStart, emit: (frame: GuestFrame) => void) {
      if (start.mode !== 'codex') throw new Error('unexpected terminal');
      const request = JSON.parse(start.prompt ?? '{}') as Request;
      starts.push({ start, request });
      let finish: (value: GuestOutcome) => void = () => {
        throw new Error('missing resolver');
      };
      const done = new Promise<GuestOutcome>((resolve) => {
        finish = resolve;
      });
      children.push(() => finish({ confirmed: true, exitCode: 0, error: null }));
      const output = (data: string) => emit({ type: 'output', stream: 'stdout', data });
      const receipt = (value: unknown) => output('WSL_APP_RESULT:' + JSON.stringify(value) + '\n');
      queueMicrotask(() => {
        if (request.operation === 'import-source') {
          receipt({
            importOperationId: request.importOperationId,
            outcome: 'imported',
            retryable: false,
            errorCode: null,
            profile,
            sourceSha256: source.sourceSha256,
          });
          finish({ confirmed: true, exitCode: 0, error: null });
        } else if (request.operation === 'export') {
          receipt({ files: currentFiles });
          finish({ confirmed: true, exitCode: 0, error: null });
        } else if (request.operation === 'start') {
          identity = { ...key, environmentId: 'sandbox', appInstanceId: request.appInstanceId };
          if (start.eduOwner && request.appInstanceId) owners.set(request.appInstanceId, start.eduOwner);
          if (!settings.omitSource) output('WSL_APP_SOURCE:' + (settings.sourceDigestMismatch ? 'f'.repeat(64) : currentHash()) + '\n');
          if (settings.duplicateSource) output('WSL_APP_SOURCE:' + source.sourceSha256 + '\n');
          output(JSON.stringify({ event: 'app-ready', identity, port: 43187 }) + '\n');
        } else if (request.operation === 'recover-owned') {
          if (JSON.stringify(owners.get(request.appInstanceId ?? '')) !== JSON.stringify(request.owner)) {
            receipt({ recoveryError: 'verification_recovery_receipt_mismatch' });
            return;
          }
          receipt({
            cleanupConfirmed: true,
            identity: request.owner?.identity,
            sourceSha256: request.owner?.sourceSha256,
            bootId: 'd21b7967-3a86-43f5-aebb-754582a3ba14',
            leader: { pid: 200, startTicks: '10' },
            members: [{ pid: 200, startTicks: '10' }],
          });
        } else throw new Error('unexpected operation ' + request.operation);
      });
      return {
        done,
        close: async () => {
          const outcome = { confirmed: !(request.operation === 'recover-owned' && settings.keeperFails), exitCode: 0, error: null };
          finish(outcome);
          return outcome;
        },
      };
    },
  };
  const options = {
    registryPath,
    startupTimeoutMs: 2000,
    ports: async (args: string[]) => {
      commands.push(args);
      if (args[0] === '--publish') {
        mapping = true;
        return 'Published 127.0.0.1:49152 -> 43187/tcp4';
      }
      if (args[0] === '--unpublish') {
        mapping = false;
        return '';
      }
      return JSON.stringify(
        mapping
          ? [{ host_ip: '127.0.0.1', host_port: settings.mappingChanged ? 49153 : 49152, sandbox_port: 43187, protocol: 'tcp4' }]
          : [],
      );
    },
    fetch: async () =>
      new Response(
        JSON.stringify({ ok: true, templateId: settings.badHealth ? 'wsl-standard-app' : 'edu-web', templateVersion: '1.0.0', identity }),
        { status: 200 },
      ),
  };
  const service = new AppService(connection, options);
  const services = [service];
  const input: AppImportRequest = { ...key, importOperationId: randomUUID(), source, files };
  expect((await service.importSource(input)).outcome).toBe('imported');
  cleanups.push(async () => {
    for (const owner of services) await Promise.allSettled([owner.shutdown()]);
    children.forEach((finish) => finish());
    await rm(root, { recursive: true, force: true });
  });
  return {
    service,
    root,
    registryPath,
    editFrontend: () => {
      currentFiles = currentFiles.map((file) =>
        file.path === 'admin/src/App.tsx' ? { ...file, base64: Buffer.from('updated frontend').toString('base64') } : file,
      );
      return currentHash();
    },
    starts,
    commands,
    restart: () => {
      const owner = new AppService(connection, options);
      services.push(owner);
      return owner;
    },
    setMappingChanged: () => {
      settings.mappingChanged = true;
    },
  };
}

describe('edu runtime and denied task boundary', () => {
  it('starts default AI0 with an owned helper, checks edu health, stops and exports immutable provenance', async () => {
    const test = await fixture();
    const running = await test.service.start(key);
    expect(running).toMatchObject({ state: 'running', profile, cleanupConfirmed: false, sourceSha256: source.sourceSha256 });
    const start = test.starts.find((call) => call.request.operation === 'start')?.start;
    if (!start || start.mode !== 'codex') throw new Error('missing start');
    expect(start.eduOwner).toEqual({
      identity: { ...key, environmentId: 'sandbox', appInstanceId: running.appInstanceId },
      sourceSha256: source.sourceSha256,
    });
    expect(start.argv.join('\n')).toContain("'EDU_AI_ENABLED': '0'");
    expect(start.argv.join('\n')).not.toContain('OWNED_PROCESS_BASE64 = ""');
    expect(JSON.parse(start.prompt ?? '{}')).not.toHaveProperty('verification');
    expect(JSON.parse(start.prompt ?? '{}')).not.toHaveProperty('agentToken');
    const before = test.starts.length;
    await expect(test.service.assertTaskAdmission(key.workspaceId)).rejects.toThrow('denied: edu tasks');
    expect(await test.service.agent(key, running.appInstanceId, { op: 'describe' }, new AbortController().signal)).toMatchObject({
      envelope: { ok: false, error: { code: 'unsupported' } },
      operationDispatched: false,
    });
    expect(await test.service.sourceSnapshot(key)).toMatchObject({ ok: false, cleanupConfirmed: true });
    expect(test.starts).toHaveLength(before);
    await expect(test.service.export(key)).rejects.toThrow('请先停止');
    expect(await test.service.stop(key)).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
    const exported = await test.service.export(key);
    expect(exported).toEqual({ files, profile, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') });
    expect(test.commands.filter((args) => args[0] === '--unpublish')).toEqual([['--unpublish', '43187/tcp4']]);
  });

  it.each(['omitSource', 'duplicateSource', 'sourceDigestMismatch', 'badHealth'] as const)(
    'rejects %s startup evidence and cleans its owned resources',
    async (fault) => {
      const test = await fixture({ [fault]: true });
      expect(await test.service.start(key)).toMatchObject({ state: 'failed', cleanupConfirmed: true, url: null });
      expect(test.commands.some((args) => args[0] === '--unpublish')).toBe(fault === 'badHealth');
    },
  );

  it('restores an interrupted owner without replaying start, then reconciles exact process and mapping facts', async () => {
    const test = await fixture();
    const running = await test.service.start(key);
    const before = test.starts.length;
    const restarted = test.restart();
    expect(await restarted.restore(key)).toMatchObject({ state: 'failed', cleanupConfirmed: false, appInstanceId: null, profile });
    expect(test.starts).toHaveLength(before);
    expect(await restarted.stop(key)).toMatchObject({ state: 'stopped', cleanupConfirmed: true, url: null });
    expect(test.starts.slice(before).map((call) => call.request.operation)).toEqual(['export', 'recover-owned']);
    expect(test.starts.at(-1)?.request.owner).toEqual({
      identity: { ...key, environmentId: 'sandbox', appInstanceId: running.appInstanceId },
      sourceSha256: source.sourceSha256,
    });
    const saved = JSON.parse(await readFile(test.registryPath, 'utf8')) as {
      version: number;
      apps: Array<{ processExpected: boolean; portPending: boolean }>;
    };
    expect(saved.version).toBe(3);
    expect(saved.apps[0]).toMatchObject({ processExpected: false, portPending: false });
  });

  it('keeps changed mapping ownership unconfirmed without removing that mapping', async () => {
    const test = await fixture();
    await test.service.start(key);
    test.setMappingChanged();
    expect(await test.restart().stop(key)).toMatchObject({ state: 'failed', cleanupConfirmed: false });
    expect(test.commands.some((args) => args[0] === '--unpublish')).toBe(false);
  });

  it('backs up v1 registry bytes before publishing the owned runtime schema and does not replay any process', async () => {
    const test = await fixture();
    const original = JSON.stringify({
      version: 1,
      sandbox: 'edu-runtime-test',
      apps: [{ ...key, cleanupConfirmed: true, state: 'stopped' }],
    });
    await writeFile(test.registryPath, original);
    const restored = test.restart();
    const before = test.starts.length;
    expect(await restored.restore(key)).toMatchObject({ profile: { projectKind: 'standard-app', profileVersion: 1 }, state: 'stopped' });
    await restored.stop(key);
    expect(test.starts).toHaveLength(before);
    expect(await readFile(test.registryPath + '.schema-v1.json', 'utf8')).toBe(original);
  });
});

it('freezes changed frontend bytes before assigning the durable owner and recovers the same source after restart', async () => {
  const test = await fixture();
  const digest = test.editFrontend();
  expect(digest).not.toBe(source.sourceSha256);
  const running = await test.service.start(key);
  expect(running).toMatchObject({ state: 'running', sourceSha256: digest });
  const launched = test.starts.find((call) => call.request.operation === 'start');
  if (!launched || launched.start.mode !== 'codex') throw new Error('missing owned launch');
  expect(launched.start.eduOwner?.sourceSha256).toBe(digest);
  expect(JSON.parse(launched.start.prompt ?? '{}').expectedSourceSha256).toBe(digest);
  expect(await test.restart().stop(key)).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
});
