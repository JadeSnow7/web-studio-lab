import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AppService, type AppSourceFile } from './app-service';
import { SbxConnection } from './sbx';
import { RuntimeConfigSchema } from '@wsl/protocol';
import { packagedTemplateRuntime } from '../../desktop/src/main/template-runtime';

async function liveConnection() {
  const file = process.env['WSL_APP_RUNTIME_CONFIG_FILE'];
  if (!file) return new SbxConnection();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  return new SbxConnection(RuntimeConfigSchema.parse(saved.config));
}

function liveDependencies() {
  const resources = process.env['WSL_APP_PACKAGED_RESOURCES'];
  if (!resources) return { dependencyArchivePath: process.env['WSL_APP_DEPENDENCY_ARCHIVE'] };
  const trusted = packagedTemplateRuntime(resources);
  return { dependencyArchivePath: trusted.archivePath, dependencyManifest: trusted };
}

// Opt-in real sandbox application check; never invokes a model or changes VS001.
it.skipIf(process.env['WSL_APP_LIVE'] !== '1')(
  'real managed standard app: identity, static UI, A/B, persistence, source export and cleanup',
  async () => {
    const projectId = `app-${randomUUID()}`;
    const key = { workspaceId: 'minimal-loop-live', projectId };
    const evidenceDir = process.env['WSL_APP_EVIDENCE_DIR'] ?? path.resolve('output/app-loop-live', projectId);
    await mkdir(evidenceDir, { recursive: true });
    const files: AppSourceFile[] = [];
    const template = path.resolve('templates/standard-app');
    async function collect(directory: string, prefix = ''): Promise<void> {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.data'].includes(item.name)) continue;
        const relative = prefix + item.name;
        if (item.isSymbolicLink()) throw new Error('template source symlink');
        if (item.isDirectory()) await collect(path.join(directory, item.name), `${relative}/`);
        else if (item.isFile())
          files.push({ path: relative, base64: (await readFile(path.join(directory, item.name))).toString('base64') });
      }
    }
    await collect(template);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const connection = await liveConnection();
    const evidence: Record<string, unknown> = {
      projectId,
      templateSourceHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      startedAt: new Date().toISOString(),
    };
    const service = new AppService(connection, {
      registryPath: path.join(evidenceDir, 'registry.json'),
      ...liveDependencies(),
    });
    try {
      const status = await connection.initialize();
      evidence['connection'] = status;
      expect(status.available, status.reason ?? '').toBe(true);
      evidence['created'] = await service.create({ ...key, files });
      const first = await service.start(key);
      evidence['firstStart'] = first;
      expect(first.state, first.error ?? '').toBe('running');
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const url = first.url ?? '';
      const health = await (await fetch(`${url}/api/health`)).json();
      evidence['health'] = health;
      const html = await (await fetch(url)).text();
      expect(html).toContain('<div id="root">');
      const script = /src="([^"]+\.js)"/.exec(html)?.[1];
      expect(script).toBeTruthy();
      expect((await fetch(new URL(script ?? '', url))).status).toBe(200);
      async function session(base: string, userId: 'A' | 'B'): Promise<string> {
        const result = await fetch(`${base}/api/dev/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        expect(result.status).toBe(200);
        const cookie = result.headers.get('set-cookie')?.split(';')[0];
        expect(cookie).toBeTruthy();
        return cookie ?? '';
      }
      const cookieA = await session(url, 'A');
      const cookieB = await session(url, 'B');
      const value = `persistent-${randomUUID()}`;
      const put = await fetch(`${url}/api/kv/live-proof`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: cookieA },
        body: JSON.stringify({ value }),
      });
      expect(put.status).toBe(200);
      evidence['stored'] = await put.json();
      const other = await fetch(`${url}/api/kv/live-proof`, { headers: { cookie: cookieB } });
      evidence['otherUserStatus'] = other.status;
      expect(other.status).toBe(404);
      const stopped = await service.stop(key);
      evidence['stopped'] = stopped;
      expect(stopped.cleanupConfirmed).toBe(true);
      await expect(fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      const restarted = await service.start(key);
      evidence['restarted'] = restarted;
      expect(restarted.state, restarted.error ?? '').toBe('running');
      expect(restarted.appInstanceId).not.toBe(first.appInstanceId);
      const cookieRestart = await session(restarted.url ?? '', 'A');
      const restored = await (await fetch(`${restarted.url}/api/kv/live-proof`, { headers: { cookie: cookieRestart } })).json();
      evidence['persisted'] = restored;
      expect(JSON.stringify(restored)).toContain(value);
      await service.stop(key);
      const exported = await service.export(key);
      evidence['export'] = { fileCount: exported.files.length, sha256: exported.sha256 };
      for (const file of exported.files) {
        const destination = path.join(evidenceDir, 'source-export', file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(file.base64, 'base64'));
      }
      expect(exported.files.some((file) => /^(node_modules|dist|\.data)\//.test(file.path))).toBe(false);
      expect(exported.files.find((file) => file.path === 'package-lock.json')?.base64).toBe(
        files.find((file) => file.path === 'package-lock.json')?.base64,
      );
      evidence['result'] = 'passed';
    } catch (error) {
      evidence['result'] = 'failed';
      evidence['error'] = String(error);
      throw error;
    } finally {
      try {
        await service.shutdown();
        evidence['shutdown'] = 'confirmed';
      } catch (error) {
        evidence['shutdown'] = String(error);
      }
      await connection.shutdown();
      evidence['endedAt'] = new Date().toISOString();
      await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(evidence, null, 2));
    }
  },
  480000,
);

it.skipIf(process.env['WSL_APP_FAILURE_LIVE'] !== '1')(
  'real owned cleanup: cancel importer, cancel guest and timeout under a health-probe fault',
  async () => {
    const registryPath = process.env['WSL_APP_EXISTING_REGISTRY'];
    if (!registryPath) throw new Error('WSL_APP_EXISTING_REGISTRY must name a stopped application registry');
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      sandbox: string;
      apps: { workspaceId: string; projectId: string; cleanupConfirmed: boolean; state: string }[];
    };
    const target = registry.apps.find((app) => !process.env['WSL_APP_PROJECT_ID'] || app.projectId === process.env['WSL_APP_PROJECT_ID']);
    if (!target || !target.cleanupConfirmed || !['created', 'stopped'].includes(target.state))
      throw new Error('Refusing to interrupt an unconfirmed or running project');
    const key = { workspaceId: target.workspaceId, projectId: target.projectId };
    const evidenceDir = process.env['WSL_APP_EVIDENCE_DIR'] ?? path.resolve('output/app-loop-failure-live', target.projectId);
    await mkdir(evidenceDir, { recursive: true });
    const evidence: Record<string, unknown> = {
      key,
      startedAt: new Date().toISOString(),
      tests: [],
      runtimeSourceSha256: createHash('sha256')
        .update(await readFile(path.resolve('apps/service/src/app-service.ts')))
        .digest('hex'),
      helperSourceSha256: createHash('sha256')
        .update(await readFile(path.resolve('apps/service/src/app-helper.py')))
        .digest('hex'),
    };
    const connection = await liveConnection();
    const dependencies = liveDependencies();
    evidence['dependencyConfiguration'] = dependencies;
    evidence['runtimeConfigFile'] = process.env['WSL_APP_RUNTIME_CONFIG_FILE'] ?? null;
    const outcomes: unknown[] = [];
    let active: AppService | undefined;
    try {
      const status = await connection.initialize();
      expect(status.available, status.reason ?? '').toBe(true);
      expect(status.sandbox).toBe(registry.sandbox);
      for (const phase of ['cancel-import', 'cancel-guest', 'timeout-guest'] as const) {
        const phaseEvidence: Record<string, unknown> = { phase, startedAt: new Date().toISOString(), snapshotEvents: [] };
        outcomes.push(phaseEvidence);
        evidence['currentPhase'] = phase;
        let started: (() => void) | undefined;
        const acquired = new Promise<void>((resolve) => {
          started = resolve;
        });
        let observedOwnedProcess = false;
        active = new AppService(connection, {
          registryPath,
          ...(phase === 'cancel-import' ? dependencies : {}),
          startupTimeoutMs: phase === 'timeout-guest' ? 60000 : 30000,
          // Explicit fault injection holds startup at the real process health gate.
          ...(phase === 'timeout-guest'
            ? {
                fetch: async (input: Parameters<typeof fetch>[0]) => {
                  phaseEvidence['healthProbeURL'] = String(input);
                  phaseEvidence['healthProbeCalls'] = Number(phaseEvidence['healthProbeCalls'] ?? 0) + 1;
                  phaseEvidence['healthProbeObservedAt'] ??= new Date().toISOString();
                  throw new TypeError('test injected health-probe unavailability');
                },
              }
            : {}),
          onSnapshot: (snapshot) => {
            const events = phaseEvidence['snapshotEvents'];
            if (Array.isArray(events)) events.push({ at: new Date().toISOString(), snapshot });
            if (snapshot.state === 'starting' && !snapshot.cleanupConfirmed) {
              observedOwnedProcess = true;
              started?.();
            }
          },
        });
        if (phase === 'cancel-import' && !dependencies.dependencyArchivePath)
          throw new Error('cancel-import requires the trusted dependency archive');
        const starting = active.start(key).then(
          (snapshot) => {
            phaseEvidence['startupResult'] = snapshot;
            return snapshot;
          },
          (error: unknown) => {
            phaseEvidence['startupRejection'] = String(error);
            throw error;
          },
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            acquired,
            starting.then((snapshot) => {
              throw new Error(`Startup finished before an owned process was acquired (${phase}): ${JSON.stringify(snapshot)}`);
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                phaseEvidence['snapshotAtGateTimeout'] = active?.get(key);
                reject(
                  new Error(
                    `No owned process acquired (${phase}); current snapshot: ${JSON.stringify(phaseEvidence['snapshotAtGateTimeout'])}`,
                  ),
                );
              }, 25000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        const result = phase === 'timeout-guest' ? await starting : await active.stop(key);
        await starting;
        expect(observedOwnedProcess).toBe(true);
        expect(result.cleanupConfirmed, result.error ?? '').toBe(true);
        expect(result.url).toBeNull();
        expect(result.state).toBe(phase === 'timeout-guest' ? 'failed' : 'stopped');
        if (phase === 'timeout-guest') {
          expect(result.error).toContain('超时');
          expect(result.guestPort).toBeGreaterThan(0);
          expect(phaseEvidence['healthProbeCalls']).toBeGreaterThan(0);
          expect(phaseEvidence['healthProbeURL'], 'Timeout must follow real guest readiness and verified owned port publication').toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/api\/health$/,
          );
        }
        const exported = await active.export(key);
        Object.assign(phaseEvidence, {
          phase,
          observedOwnedProcess,
          snapshot: result,
          sourceSha256: exported.sha256,
          sourceCount: exported.files.length,
          ...(phase === 'timeout-guest'
            ? { fault: 'Host health probe deliberately reports unavailable; actual guest process and owned mapping cleanup are exercised.' }
            : {}),
        });
        await active.shutdown();
        active = undefined;
      }
      evidence['result'] = 'passed';
    } catch (error) {
      evidence['result'] = 'failed';
      evidence['error'] = String(error);
      throw error;
    } finally {
      if (active) {
        try {
          evidence['snapshotBeforeShutdown'] = active.get(key);
          await active.shutdown();
          evidence['snapshotAfterShutdown'] = active.get(key);
        } catch (error) {
          evidence['cleanupError'] = String(error);
        }
      }
      await connection.shutdown();
      evidence['tests'] = outcomes;
      evidence['endedAt'] = new Date().toISOString();
      await writeFile(path.join(evidenceDir, 'failure-lifecycle-result.json'), JSON.stringify(evidence, null, 2));
    }
  },
  180000,
);
