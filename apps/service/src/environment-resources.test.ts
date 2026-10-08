import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentResources } from './environment-resources';
import { SbxConnection } from './sbx';
import type { ObservationRequest, ResourceInstanceIdentity } from '@wsl/protocol';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function registry(env: NodeJS.ProcessEnv = {}) {
  const resources = new EnvironmentResources(new SbxConnection(), vi.fn(), vi.fn(), env);
  cleanup.push(() => resources.shutdown());
  return resources;
}
const identity = {
  workspaceId: 'w-a',
  environmentId: 'local',
  resourceId: 'file-a',
  kind: 'file' as const,
  instanceId: 'i-a',
  instanceGeneration: 1,
};
function request(target: ResourceInstanceIdentity, tool: ObservationRequest['tool'] = 'files.read'): ObservationRequest {
  return { requestId: 'r', workspaceId: target.workspaceId, sessionId: null, runId: null, target, tool, args: { path: 'x' } };
}
it('does not grant a default local root or derive SSH capabilities from partial configuration', async () => {
  const resources = registry({ WSL_SSH_HOST: 'example.test' });
  expect(resources.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ environmentId: 'local', capabilities: { browser: true, terminal: false, files: false } }),
      expect.objectContaining({ environmentId: 'ssh', state: 'unavailable' }),
    ]),
  );
  await resources.register(identity);
  expect(await resources.observe(request(identity))).toMatchObject({ error: 'unavailable' });
  expect(await resources.observe(request({ ...identity, workspaceId: 'w-b' }))).toMatchObject({ error: 'unauthorized' });
});
it('enumerating a fully configured SSH environment does not connect or launch a shell', async () => {
  const resources = registry({
    WSL_SSH_HOST: '127.0.0.1',
    WSL_SSH_USER: 'test',
    WSL_SSH_ROOT: '/test',
    WSL_SSH_HOST_KEY_SHA256: 'a'.repeat(64),
    SSH_AUTH_SOCK: '/configured/agent.sock',
  });
  expect(resources.list().find((env) => env.environmentId === 'ssh')).toMatchObject({ state: 'configured' });
  await expect(resources.shutdown()).resolves.toBeUndefined();
});
it('keeps file cursors and results scoped to each Main resource and refuses retired generations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-env-files-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'x'), 'contents across spaces');
  const resources = registry({ WSL_OBSERVATION_ROOT: root });
  const other = { ...identity, workspaceId: 'w-b', resourceId: 'file-b', instanceId: 'i-b' };
  await resources.register(identity);
  await resources.register(other);
  const first = await resources.observe({ ...request(identity), args: { path: 'x', maxBytes: 4 } });
  expect(first).toMatchObject({ resource: identity });
  if ('error' in first) throw new Error(first.message);
  expect(await resources.observe({ ...request(other), args: { path: 'x', cursor: first.nextCursor } })).toMatchObject({
    error: 'stale_cursor',
  });
  await expect(resources.register({ ...identity, workspaceId: 'forged' })).rejects.toMatchObject({ code: 'unauthorized' });
  await resources.register({ ...identity, instanceId: 'i-next', instanceGeneration: 2 });
  expect(await resources.observe(request(identity))).toMatchObject({ error: 'unauthorized' });
  await expect(resources.register(identity)).rejects.toMatchObject({ code: 'unavailable' });
});
it('resource registration restores descriptors without automatically opening a terminal', async () => {
  const resources = registry();
  const terminal = { ...identity, kind: 'terminal' as const, environmentId: 'sandbox' };
  await resources.register(terminal);
  expect(() => resources.terminal(terminal)).toThrow('not open');
  expect(resources.terminalSnapshot(terminal)).toMatchObject({ state: 'idle', sessionId: null, cleanupPending: false });
  expect(await resources.observe({ ...request(terminal, 'terminal.read_output'), args: {} })).toMatchObject({ error: 'unavailable' });
});

it('rejects cancelled and invalid external reads without granting a file source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-env-cancel-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'x'), 'contents');
  const resources = registry({ WSL_OBSERVATION_ROOT: root });
  await resources.register(identity);
  const abort = new AbortController();
  abort.abort();
  expect(await resources.observe(request(identity), abort.signal)).toMatchObject({ error: 'cancelled' });
  expect(await resources.observe({ ...request(identity), args: { path: 'x', grantRoot: '/' } })).toMatchObject({
    error: 'invalid_request',
  });
  expect(await resources.observe({ ...request(identity), target: null })).toMatchObject({ error: 'unauthorized' });
});
