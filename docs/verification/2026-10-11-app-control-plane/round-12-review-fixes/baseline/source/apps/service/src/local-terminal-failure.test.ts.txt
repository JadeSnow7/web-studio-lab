import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }));
import { LocalTerminal } from './local-terminal';
import { EnvironmentResources } from './environment-resources';
import { SbxConnection } from './sbx';
const identity = {
  workspaceId: 'w',
  environmentId: 'local',
  resourceId: 'terminal',
  kind: 'terminal' as const,
  instanceId: 'instance',
  instanceGeneration: 1,
};
function helper() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  fixture.spawn.mockReturnValue(child);
  return child;
}
it('refuses close and shutdown after helper exit without a cleanup acknowledgement', async () => {
  const child = helper();
  const terminal = new LocalTerminal('/authorized', identity, () => {});
  const opened = await terminal.open(80, 24);
  child.emit('close', 1);
  expect(terminal.get().cleanupPending).toBe(true);
  await expect(terminal.close(opened.sessionId!)).rejects.toThrow('cleanup');
  await expect(terminal.shutdown()).rejects.toThrow('cleanup');
});
it('does not replace a Main lease whose local process cleanup remains unknown', async () => {
  const child = helper();
  const resources = new EnvironmentResources(
    new SbxConnection(),
    () => {},
    () => {},
    { WSL_OBSERVATION_ROOT: '/authorized' },
  );
  await resources.register(identity);
  await resources.openTerminal(identity, 80, 24);
  child.emit('close', 1);
  await expect(resources.register({ ...identity, instanceId: 'next', instanceGeneration: 2 })).rejects.toThrow('cleanup');
  await expect(resources.shutdown()).rejects.toThrow('cleanup');
});
