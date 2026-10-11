import { expect, it, vi } from 'vitest';
import { FileObservationProvider, type FileTransport } from './observation-files';
const fixture = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('./observation-ssh', () => ({
  SshObservationConnection: class {
    static connect = fixture.connect;
  },
}));
import { EnvironmentResources } from './environment-resources';
import { SbxConnection } from './sbx';
const identity = {
  workspaceId: 'w',
  environmentId: 'ssh',
  resourceId: 'file',
  kind: 'file' as const,
  instanceId: 'instance',
  instanceGeneration: 1,
};
const env = {
  WSL_SSH_HOST: '127.0.0.1',
  WSL_SSH_USER: 'test',
  WSL_SSH_ROOT: '/authorized',
  WSL_SSH_HOST_KEY_SHA256: 'a'.repeat(64),
  SSH_AUTH_SOCK: '/agent',
};
function pendingFiles() {
  let release!: (transport: FileTransport) => void;
  const pending = new Promise<FileTransport>((resolve) => {
    release = resolve;
  });
  const connection = { available: true, close: vi.fn(), fileTransport: vi.fn(() => pending) };
  fixture.connect.mockResolvedValue(connection);
  const transport = {
    generation: 'g',
    available: true,
    remote: true,
    realpath: async (path: string) => path,
    read: vi.fn(async () => Buffer.from('late')),
    list: async () => ({ entries: [], truncated: false }),
  };
  const resources = new EnvironmentResources(
    new SbxConnection(),
    () => {},
    () => {},
    env,
  );
  return { resources, connection, transport, release };
}
it('safely retires a pending SSH file acquisition without treating cancellation as failed cleanup', async () => {
  const { resources, connection, transport, release } = pendingFiles();
  await resources.register(identity);
  const read = resources.observe({
    requestId: 'r',
    workspaceId: 'w',
    sessionId: null,
    runId: null,
    target: identity,
    tool: 'files.read',
    args: { path: 'x' },
  });
  await vi.waitFor(() => expect(connection.fileTransport).toHaveBeenCalledOnce());
  const stopping = resources.shutdown();
  release(transport);
  await expect(stopping).resolves.toBeUndefined();
  expect(await read).toMatchObject({ error: 'unavailable' });
  expect(connection.close).toHaveBeenCalledOnce();
  expect(transport.read).not.toHaveBeenCalled();
});
it('does not leak a late SSH file provider when Main replaces its pending lease', async () => {
  const { resources, connection, transport, release } = pendingFiles();
  await resources.register(identity);
  const read = resources.observe({
    requestId: 'r',
    workspaceId: 'w',
    sessionId: null,
    runId: null,
    target: identity,
    tool: 'files.read',
    args: { path: 'x' },
  });
  await vi.waitFor(() => expect(connection.fileTransport).toHaveBeenCalledOnce());
  const replacing = resources.register({ ...identity, instanceId: 'next', instanceGeneration: 2 });
  release(transport);
  await replacing;
  expect(await read).toMatchObject({ error: 'unavailable' });
  expect(transport.read).not.toHaveBeenCalled();
  await resources.shutdown();
  expect(connection.close).toHaveBeenCalledOnce();
});

it('waits for a pending SSH terminal acquisition and releases its channel before replacing its lease', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const channelClose = vi.fn();
  const connection = {
    available: true,
    close: vi.fn(),
    openShell: vi.fn(async (_size, handlers) => {
      await ready;
      return {
        sessionId: 'owned-shell',
        connectionId: 'connection',
        write: vi.fn(),
        resize: vi.fn(),
        close: () => {
          channelClose();
          handlers.closed({ exitCode: 0, disconnected: false });
        },
      };
    }),
  };
  fixture.connect.mockResolvedValue(connection);
  const resources = new EnvironmentResources(
    new SbxConnection(),
    () => {},
    () => {},
    env,
  );
  const terminal = { ...identity, kind: 'terminal' as const };
  await resources.register(terminal);
  const opening = resources.openTerminal(terminal, 80, 24);
  await vi.waitFor(() => expect(connection.openShell).toHaveBeenCalledOnce());
  let replaced = false;
  const replacing = resources.register({ ...terminal, instanceId: 'next', instanceGeneration: 2 }).then(() => {
    replaced = true;
  });
  await Promise.resolve();
  expect(replaced).toBe(false);
  release();
  await opening;
  await replacing;
  expect(channelClose).toHaveBeenCalledOnce();
  await resources.shutdown();
  expect(connection.close).toHaveBeenCalledOnce();
});

it('propagates actual late-provider cleanup failure while still closing the owned SSH connection', async () => {
  const { resources, connection, transport, release } = pendingFiles();
  const close = vi.spyOn(FileObservationProvider.prototype, 'close').mockRejectedValue(new Error('file watch cleanup failed'));
  try {
    await resources.register(identity);
    const read = resources.observe({
      requestId: 'r',
      workspaceId: 'w',
      sessionId: null,
      runId: null,
      target: identity,
      tool: 'files.read',
      args: { path: 'x' },
    });
    await vi.waitFor(() => expect(connection.fileTransport).toHaveBeenCalledOnce());
    const stopping = resources.shutdown();
    const rejection = expect(stopping).rejects.toThrow('file watch cleanup failed');
    release(transport);
    await rejection;
    expect(await read).toMatchObject({ error: 'unavailable', message: 'file watch cleanup failed' });
    expect(connection.close).toHaveBeenCalledOnce();
  } finally {
    close.mockRestore();
  }
});
