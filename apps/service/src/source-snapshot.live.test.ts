import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { AppSourceSnapshotResultSchema, SourcePathSchema, type AppSourceSnapshot } from '@wsl/protocol';
import { AppService, type AppSourceFile } from './app-service';
import { SbxConnection, type GuestProcess } from './sbx';
import { RunSourceRepository } from '../../desktop/src/main/workbench/run-source-repository';
import { packagedTemplateRuntime } from '../../desktop/src/main/template-runtime';

const mutateOwnedFixture = `import json,sys,uuid
from pathlib import Path
request=json.loads(sys.stdin.readline())
project=str(uuid.UUID(request['projectId']))
root=Path('/home/agent/workspace/.wsl-apps')/project
if root.is_symlink(): raise ValueError('fixture root symlink')
if json.loads((root/'.wsl-identity.json').read_text()) != {'workspaceId':request['workspaceId'],'environmentId':'sandbox','projectId':project}: raise ValueError('fixture identity mismatch')
file=root/'src/App.tsx'
if file.is_symlink(): raise ValueError('fixture source symlink')
source=file.read_text()
old="busy ? '检查中…' : '检查连接'"
if source.count(old) != 1: raise ValueError('fixture button changed')
nonce=request['nonce']
if not nonce.startswith('WSL_D_HELPER_') or not nonce.replace('_','').isalnum(): raise ValueError('fixture nonce invalid')
file.write_text(source.replace(old,"busy ? '检查中…' : '"+nonce+"'"))
print('owned fixture changed', flush=True)
`;

it.skipIf(process.env['WSL_SOURCE_SNAPSHOT_LIVE'] !== '1')(
  'live: stopped/running source helpers preserve the owned standard App and produce a host-only diff without a model',
  async () => {
    const sandbox = process.env['WSL_SBX_NAME'];
    if (!sandbox) throw new Error('WSL_SBX_NAME must explicitly select an authorized live sandbox');
    const projectId = randomUUID();
    const key = { workspaceId: `source-helper-${projectId}`, projectId };
    const nonce = `WSL_D_HELPER_${projectId.replaceAll('-', '')}`;
    const evidenceRoot = path.resolve('docs/verification/2026-10-15-p0-video', nonce);
    await mkdir(evidenceRoot, { recursive: true });
    const privateRoot = await mkdtemp(path.join(tmpdir(), 'wsl-d-helper-private-'));
    const connection = new SbxConnection({ sandbox, sbxBinary: process.env['WSL_SBX_BIN'] ?? '/opt/homebrew/bin/sbx' });
    const resources = process.env['WSL_APP_PACKAGED_RESOURCES'];
    const dependencies = resources ? packagedTemplateRuntime(resources) : undefined;
    const service = new AppService(connection, {
      registryPath: path.join(privateRoot, 'registry.json'),
      dependencyArchivePath: dependencies?.archivePath ?? process.env['WSL_APP_DEPENDENCY_ARCHIVE'],
      dependencyManifest: dependencies,
    });
    const repository = new RunSourceRepository(path.join(privateRoot, 'runs'));
    const evidence: Record<string, unknown> = {
      nonce,
      sandbox,
      key,
      startedAt: new Date().toISOString(),
      result: 'running',
      modelCalls: 0,
    };
    const cleanupErrors: string[] = [];
    let probe: GuestProcess | undefined;
    let failure: unknown;
    const record = async (stage: string) => {
      evidence['stage'] = stage;
      await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    };
    const capture = async (): Promise<AppSourceSnapshot> => {
      const before = service.get(key);
      const result = AppSourceSnapshotResultSchema.parse(await service.sourceSnapshot(key));
      expect(result.ok).toBe(true);
      expect(result.cleanupConfirmed).toBe(true);
      if (!result.ok) throw new Error('Live source capture unavailable');
      expect(service.get(key)).toEqual(before);
      expect(result.snapshot.files.some((file) => file.path.toLowerCase().startsWith('.env'))).toBe(false);
      expect(JSON.stringify(result.snapshot)).not.toContain(Buffer.from('SOURCE_HELPER_SYNTHETIC=not-a-real-secret\n').toString('base64'));
      return result.snapshot;
    };
    try {
      const status = await connection.initialize();
      expect(status.available).toBe(true);
      expect(status.sandbox).toBe(sandbox);
      const files: AppSourceFile[] = [];
      const template = path.resolve('templates/standard-app');
      const collect = async (directory: string, prefix = ''): Promise<void> => {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          const name = prefix + item.name;
          if (!SourcePathSchema.safeParse(name).success) continue;
          if (item.isSymbolicLink()) throw new Error('Template fixture source must not contain symlinks');
          if (item.isDirectory()) await collect(path.join(directory, item.name), `${name}/`);
          else if (item.isFile()) files.push({ path: name, base64: (await readFile(path.join(directory, item.name))).toString('base64') });
        }
      };
      await collect(template);
      for (const name of ['.env', '.env.example'])
        files.push({ path: name, base64: Buffer.from('SOURCE_HELPER_SYNTHETIC=not-a-real-secret\n').toString('base64') });
      expect((await service.create({ ...key, files })).state).toBe('created');
      expect((await service.stop(key)).cleanupConfirmed).toBe(true);
      expect(service.get(key).state).toBe('stopped');
      const before = await capture();
      const runId = randomUUID();
      const { baseTree } = await repository.createBaseline(runId, before);
      await record('stopped-baseline');
      probe = connection.start(
        {
          type: 'start',
          mode: 'codex',
          argv: ['python3', '-I', '-u', '-c', mutateOwnedFixture],
          prompt: JSON.stringify({ ...key, nonce }),
        },
        () => undefined,
      );
      const outcome = await probe.done;
      expect(outcome).toMatchObject({ confirmed: true, exitCode: 0, error: null });
      probe = undefined;
      const after = await capture();
      const changed = await repository.capture(runId, baseTree, after);
      expect(changed.files.map((file) => file.path)).toEqual(['src/App.tsx']);
      expect(changed.truncated).toBe(false);
      const patch = await repository.readPatch(runId, changed.patchSha256);
      expect(patch).toContain(nonce);
      expect(createHash('sha256').update(patch).digest('hex')).toBe(changed.patchSha256);
      expect(patch).not.toContain('not-a-real-secret');
      evidence['sourceChange'] = changed;
      await writeFile(path.join(evidenceRoot, 'source.patch'), patch);
      await record('host-diff');
      const running = await service.start(key);
      expect(running.state).toBe('running');
      expect(running.cleanupConfirmed).toBe(false);
      expect(running.appInstanceId).toBeTruthy();
      const live = await capture();
      expect(live.files.find((file) => file.path === 'src/App.tsx')).toEqual(after.files.find((file) => file.path === 'src/App.tsx'));
      expect(service.get(key)).toEqual(running);
      const health = z
        .object({ ok: z.literal(true), identity: z.object({ workspaceId: z.string(), projectId: z.string(), appInstanceId: z.string() }) })
        .parse(await (await fetch(`${running.url}/api/health`, { signal: AbortSignal.timeout(10000) })).json());
      expect(health.identity).toMatchObject({ ...key, appInstanceId: running.appInstanceId });
      evidence['runningOwnership'] = {
        ...key,
        appInstanceId: running.appInstanceId,
        state: service.get(key).state,
        cleanupConfirmed: service.get(key).cleanupConfirmed,
      };
      const stopped = await service.stop(key);
      expect(stopped).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
      expect(await capture()).toMatchObject({ ...key });
      evidence['result'] = 'passed';
      await record('stopped-again');
    } catch (error) {
      failure = error;
      evidence['result'] = 'failed';
      evidence['failureKind'] = error instanceof Error ? error.name : 'unknown';
    } finally {
      if (probe) {
        try {
          if (!(await probe.close()).confirmed) cleanupErrors.push('Owned fixture stimulus cleanup unconfirmed');
        } catch {
          cleanupErrors.push('Owned fixture stimulus cleanup failed');
        }
      }
      try {
        await service.shutdown();
      } catch {
        cleanupErrors.push('Owned App/source cleanup unconfirmed');
      }
      try {
        await connection.shutdown();
      } catch {
        cleanupErrors.push('Owned connection probe cleanup unconfirmed');
      }
      if (connection.getCleanupPending()) cleanupErrors.push('Connection retains an unconfirmed owned process');
      evidence['cleanupErrors'] = cleanupErrors;
      evidence['endedAt'] = new Date().toISOString();
      if (cleanupErrors.length) evidence['result'] = 'failed';
      await record('cleanup');
      console.log('SOURCE_SNAPSHOT_LIVE_EVIDENCE', evidenceRoot, 'PRIVATE_RUNTIME', privateRoot);
    }
    if (failure) throw failure;
    expect(cleanupErrors).toEqual([]);
  },
  600000,
);
