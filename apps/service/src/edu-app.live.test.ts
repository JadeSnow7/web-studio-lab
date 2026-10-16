import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { collectEduSource } from '../../desktop/src/main/workbench/edu-source';
import { AppService } from './app-service';
import { SbxConnection } from './sbx';

it.skipIf(process.env['WSL_EDU_LIVE'] !== '1')(
  'real edu service import, runtime identity, restart and source export',
  async () => {
    const root = process.env['WSL_EDU_SOURCE_ROOT'];
    const evidenceRoot = process.env['WSL_EDU_EVIDENCE'];
    if (!root || !evidenceRoot || !/^wsl-edu-/.test(process.env['WSL_SBX_NAME'] ?? ''))
      throw new Error('explicit edu source, fresh evidence directory and task-exclusive sandbox are required');
    await mkdir(evidenceRoot, { mode: 0o700 });
    const source = await collectEduSource(root, new AbortController().signal);
    const connection = new SbxConnection();
    const registryPath = path.join(evidenceRoot, 'registry.json');
    const key = { workspaceId: 'edu-service-live', projectId: randomUUID() };
    let service = new AppService(connection, { registryPath });
    const evidence: Record<string, unknown> = {
      scope: 'real-app-service-sbx-not-electron',
      startedAt: new Date().toISOString(),
      key,
      source: source.source,
      result: 'not_run',
    };
    try {
      const status = await connection.initialize();
      evidence['connection'] = status;
      expect(status.available, status.reason ?? '').toBe(true);
      evidence['imported'] = await service.importEdu({ ...key, ...source });
      const first = await service.start(key);
      evidence['first'] = first;
      expect(first.state, first.error ?? '').toBe('running');
      expect(first.sourceSha256).toBe(source.source.sourceSha256);
      const health = await (await fetch(first.url + '/api/health', { redirect: 'error' })).json();
      expect(health).toEqual({
        ok: true,
        templateId: 'edu-web',
        templateVersion: '1.0.0',
        identity: { ...key, environmentId: 'sandbox', appInstanceId: first.appInstanceId },
      });
      const pages = [];
      for (const route of ['/', '/student']) {
        const response = await fetch(first.url + route, { redirect: 'error' });
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain('<div id="root">');
        pages.push({ route, status: response.status });
      }
      evidence['pages'] = pages;
      evidence['stopped'] = await service.stop(key);
      expect(service.get(key).cleanupConfirmed).toBe(true);
      await expect(fetch(first.url + '/api/health', { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      await service.shutdown();
      service = new AppService(connection, { registryPath });
      const restored = await service.restore(key);
      evidence['restored'] = restored;
      expect(restored).toMatchObject({ state: 'stopped', appInstanceId: null, cleanupConfirmed: true, profile: first.profile });
      const second = await service.start(key);
      evidence['second'] = second;
      expect(second.state, second.error ?? '').toBe('running');
      expect(second.appInstanceId).not.toBe(first.appInstanceId);
      expect((await service.stop(key)).cleanupConfirmed).toBe(true);
      const exported = await service.export(key);
      expect(exported.files).toEqual(source.files);
      expect(exported.profile).toEqual(first.profile);
      evidence['export'] = { fileCount: exported.files.length, transportSha256: exported.sha256, profile: exported.profile };
      evidence['result'] = 'passed';
    } catch (error) {
      evidence['result'] = 'failed';
      evidence['error'] = String(error);
      throw error;
    } finally {
      try {
        await service.shutdown();
        evidence['serviceCleanup'] = 'confirmed';
      } catch (error) {
        evidence['serviceCleanup'] = 'undetermined';
        evidence['cleanupError'] = String(error);
        evidence['result'] = 'failed';
      }
      await connection.shutdown();
      evidence['endedAt'] = new Date().toISOString();
      await writeFile(path.join(evidenceRoot, 'result.json'), JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
      expect(evidence['serviceCleanup']).toBe('confirmed');
    }
  },
  600_000,
);
