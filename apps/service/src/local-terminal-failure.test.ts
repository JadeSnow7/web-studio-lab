import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
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
type Helper = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number };
const children: Helper[] = [];
function helper(): Helper {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 1000000 + children.length,
  });
  fixture.spawn.mockReturnValue(child);
  children.push(child);
  return child;
}
const terminals: LocalTerminal[] = [];
function terminal(python?: string) {
  const result = new LocalTerminal('/authorized', identity, () => {}, python);
  terminals.push(result);
  return result;
}
afterEach(() => {
  for (const instance of terminals.splice(0)) instance.observation?.dispose();
  for (const child of children.splice(0)) {
    child.emit('close', 1);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.removeAllListeners();
  }
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  fixture.spawn.mockReset();
});

it('reports a missing Python executable without declaring the PTY running or cleanup confirmed', async () => {
  const child = helper();
  const instance = terminal('/missing-python-for-pty-test');
  const opened = await instance.open(80, 24);
  if (!opened.sessionId) throw new Error('PTY did not allocate a session');
  const sessionId = opened.sessionId;
  expect(fixture.spawn.mock.calls[0]?.[0]).toBe('/missing-python-for-pty-test');
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  expect(instance.get().state).toBe('failed');
  expect(instance.get().error).toBe('local PTY helper unavailable');
  expect(instance.get().cleanupPending).toBe(true);
  expect(() => instance.write(sessionId, 'true\n')).toThrow('unavailable');
  child.emit('close', -2);
  expect(instance.get().state).toBe('failed');
  expect(instance.get().cleanupPending).toBe(true);
  await expect(instance.close(sessionId)).rejects.toThrow('cleanup');
  await expect(instance.open(80, 24)).rejects.toThrow('previous PTY cleanup unconfirmed');
  await expect(instance.shutdown()).rejects.toThrow('cleanup');
});

it('a helper that never becomes ready can be cancelled without accepting a late ready frame', async () => {
  const child = helper();
  const instance = terminal();
  const opened = await instance.open(80, 24);
  if (!opened.sessionId) throw new Error('PTY did not allocate a session');
  const sessionId = opened.sessionId;
  expect(instance.get().state).toBe('starting');
  expect(() => instance.write(sessionId, 'true\n')).toThrow('unavailable');
  const failures: unknown[] = [];
  // Handle rejection immediately, including when an intervening state assertion fails.
  const closing = instance.close(sessionId).then(
    () => ({ status: 'fulfilled' as const }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
  try {
    expect(instance.get().state).toBe('closing');
    child.stdout.write(
      JSON.stringify({ type: 'ready', helper: { pid: child.pid, birth: [1, 0] }, root: { pid: child.pid + 100, birth: [2, 0] } }) + '\n',
    );
    expect(instance.get().state).toBe('closing');
    expect(() => instance.write(sessionId, 'true\n')).toThrow('unavailable');
  } catch (error) {
    failures.push(error);
  } finally {
    child.stdout.write('{"type":"cleanup","ok":true}\n');
    child.emit('close', 0);
    const result = await closing;
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'PTY cancellation assertion and fixture cleanup failed');
  expect(instance.get().state).toBe('closed');
  expect(instance.get().cleanupPending).toBe(false);
  await instance.shutdown();
});

it('bounds cancellation of a never-ready helper at five seconds and retains unknown cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const child = helper();
  const instance = terminal();
  const opened = await instance.open(80, 24);
  if (!opened.sessionId) throw new Error('PTY did not allocate a session');
  // Production has no startup deadline: a functional-test timeout must not invent one.
  await vi.advanceTimersByTimeAsync(5000);
  expect(instance.get().state).toBe('starting');
  let settled = false;
  const closing = instance.close(opened.sessionId).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const error = await closing;
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('message', 'PTY cleanup timeout');
  expect(instance.get().state).toBe('closing');
  expect(instance.get().cleanupPending).toBe(true);
  child.stdout.write(
    JSON.stringify({ type: 'ready', helper: { pid: child.pid, birth: [1, 0] }, root: { pid: child.pid + 100, birth: [2, 0] } }) + '\n',
  );
  expect(instance.get().state).toBe('closing');
  child.emit('close', 1);
  expect(instance.get().state).toBe('failed');
  expect(instance.get().cleanupPending).toBe(true);
  await expect(instance.open(80, 24)).rejects.toThrow('previous PTY cleanup unconfirmed');
  await expect(instance.shutdown()).rejects.toThrow('cleanup');
});

it('refuses close and shutdown after helper exit without a cleanup acknowledgement', async () => {
  const child = helper();
  const instance = terminal();
  const opened = await instance.open(80, 24);
  if (!opened.sessionId) throw new Error('PTY did not allocate a session');
  child.emit('close', 1);
  expect(instance.get().state).toBe('failed');
  expect(instance.get().cleanupPending).toBe(true);
  await expect(instance.close(opened.sessionId)).rejects.toThrow('cleanup');
  await expect(instance.shutdown()).rejects.toThrow('cleanup');
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

it('rejects a ready identity that does not match the actual spawned helper', async () => {
  const child = helper();
  const instance = terminal();
  await instance.open(80, 24);
  child.stdout.write(
    JSON.stringify({ type: 'ready', helper: { pid: child.pid + 1, birth: [1, 0] }, root: { pid: child.pid + 100, birth: [2, 0] } }) + '\n',
  );
  expect(instance.get().state).toBe('starting');
  expect(instance.get().error).toBe('invalid PTY transport');
  expect(instance.get().cleanupPending).toBe(true);
  child.emit('close', 1);
  await expect(instance.shutdown()).rejects.toThrow('cleanup');
});

it('only transmits peers registered by another spawned helper and removes them on exit', async () => {
  const aChild = helper();
  const a = terminal();
  const aSession = (await a.open(80, 24)).sessionId!;
  aChild.stdout.write(
    JSON.stringify({ type: 'ready', helper: { pid: aChild.pid, birth: [1, 0] }, root: { pid: aChild.pid + 100, birth: [2, 0] } }) + '\n',
  );
  const bChild = helper();
  const b = terminal();
  await b.open(80, 24);
  const bPeer = { helper: { pid: bChild.pid, birth: [3, 0] }, root: { pid: bChild.pid + 100, birth: [4, 0] } };
  bChild.stdout.write(JSON.stringify({ type: 'ready', ...bPeer }) + '\n');
  const frames: unknown[] = [];
  aChild.stdin.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) frames.push(JSON.parse(line));
  });
  await vi.waitFor(() => expect(b.get().state).toBe('running'));
  a.write(aSession, 'exit\n');
  await vi.waitFor(() => expect(frames.at(-1)).toEqual({ type: 'input', data: 'exit\n', peers: [bPeer] }));
  bChild.emit('close', 1);
  await vi.waitFor(() => expect(frames.at(-1)).toEqual({ type: 'peers', peers: [] }));
  aChild.emit('close', 1);
  await expect(a.shutdown()).rejects.toThrow('cleanup');
  await expect(b.shutdown()).rejects.toThrow('cleanup');
});
