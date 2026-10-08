import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { FileWorkbenchRepository } from './repository';
import type { ObservationRecord } from '@wsl/protocol';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-observation-persistence-'));
  roots.push(root);
  return { root, file: path.join(root, 'workbench.json'), repository: new FileWorkbenchRepository(path.join(root, 'workbench.json')) };
}
const legacy = () => ({
  appInstanceId: 'old-app',
  activeWorkspaceId: 'w',
  seq: 3,
  storageError: null,
  notificationReadReceipts: [],
  workspaces: [
    {
      workspaceId: 'w',
      name: '旧空间',
      revision: 4,
      tabs: [{ tabId: 'web-tab', title: '页面', pinned: false, group: null, targetRef: { kind: 'web', resourceId: 'web' } }],
      layout: { kind: 'pane', paneId: 'pane', tabId: 'web-tab' },
      activePaneId: 'pane',
      sessions: [],
      runs: [],
      publicResources: null,
      theme: 'warm',
      resources: ['web', 'terminal', 'file', 'ssh'].map((kind) => ({
        resourceId: kind,
        kind,
        title: kind,
        url: kind === 'web' ? 'https://example.com' : null,
        instanceId: kind + '-old-instance',
        generation: 2,
        preview: null,
        terminal: null,
        unavailableReason: null,
      })),
    },
  ],
});
it('explicitly migrates schema1 environment bindings while retaining resource and layout identities', async () => {
  const { file, repository } = await setup();
  const old = legacy();
  await writeFile(file, JSON.stringify({ schemaVersion: 1, snapshot: old }));
  const loaded = await repository.load();
  expect(loaded?.workspaces[0]?.resources.map((r) => [r.resourceId, r.environmentId])).toEqual([
    ['web', 'local'],
    ['terminal', 'sandbox'],
    ['file', null],
    ['ssh', null],
  ]);
  expect(loaded?.workspaces[0]?.layout).toEqual(old.workspaces[0]?.layout);
  expect(loaded?.workspaces[0]?.tabs).toEqual(old.workspaces[0]?.tabs);
  expect(loaded?.workspaces[0]?.theme).toBe('warm');
  expect(loaded?.workspaces[0]?.resources.filter((r) => ['file', 'ssh'].includes(r.kind)).every((r) => r.unavailableReason)).toBe(true);
});
it('writes schema2 business descriptors without runtime handles and rejects future schema unchanged', async () => {
  const { file, repository } = await setup();
  await writeFile(file, JSON.stringify({ schemaVersion: 1, snapshot: legacy() }));
  const loaded = await repository.load();
  if (!loaded) throw new Error('fixture');
  loaded.workspaces[0]!.resources[1]!.terminal = {
    sessionId: 'runtime-secret-handle',
    seq: 4,
    sandbox: 'configured',
    cwd: '/runtime',
    state: 'running',
    output: 'history',
    cleanupPending: true,
    error: null,
  };
  await repository.save(loaded);
  const content = await readFile(file, 'utf8');
  expect(JSON.parse(content).schemaVersion).toBe(2);
  expect(content).not.toContain('runtime-secret-handle');
  expect(content).not.toContain('-old-instance');
  const restored = await repository.load();
  expect(restored?.workspaces[0]?.resources[1]?.terminal?.output).toBe('history');
  const future = JSON.stringify({ schemaVersion: 99, snapshot: loaded });
  await writeFile(file, future);
  await expect(repository.load()).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe(future);
});
it('publishes each observation as a fresh immutable Main evidence file', async () => {
  const { root, repository } = await setup();
  const record: ObservationRecord = {
    request: {
      requestId: 'request',
      workspaceId: 'w',
      sessionId: 's',
      runId: 'run',
      target: null,
      tool: 'workspace.list_sources',
      args: {},
    },
    state: 'completed',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    evidenceRef: null,
    result: { kind: 'sources', workspaceId: 'w', sources: [] },
  };
  const first = await repository.appendObservation(record);
  const bytes = await readFile(path.join(root, first), 'utf8');
  const second = await repository.appendObservation({ ...record, result: { error: 'cancelled', message: 'cancelled' } });
  expect(first).not.toBe(second);
  expect(await readFile(path.join(root, first), 'utf8')).toBe(bytes);
  expect(await readdir(path.join(root, 'observations'))).toHaveLength(2);
  expect(JSON.parse(bytes).request).toMatchObject({ workspaceId: 'w', sessionId: 's', runId: 'run' });
});
