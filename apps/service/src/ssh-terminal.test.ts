import { describe, it, expect, vi } from 'vitest';
import { SshTerminal } from './ssh-terminal';
import type { SshObservationConnection } from './observation-ssh';
describe('SSH terminal session binding', () => {
  it('releases starting state when the server rejects shell so the user can retry', async () => {
    const openShell = vi.fn().mockRejectedValue(new Error('server rejects shell'));
    const terminal = new SshTerminal(
      { available: true, connectionId: 'connection', openShell, close: vi.fn() } as unknown as SshObservationConnection,
      {
        workspaceId: 'w',
        environmentId: 'ssh',
        resourceId: 'ssh-terminal',
        kind: 'terminal',
        instanceId: 'ssh-instance',
        instanceGeneration: 1,
      },
      () => {},
    );
    await expect(terminal.open(80, 24)).rejects.toThrow('could not be opened');
    expect(terminal.get()).toMatchObject({ state: 'failed', cleanupPending: false });
    await expect(terminal.open(80, 24)).rejects.toThrow('could not be opened');
    expect(openShell).toHaveBeenCalledTimes(2);
  });
  it('retains early output on reopen and rejects old targets without changing state', async () => {
    type Handlers = { output(data: string): void; closed(result: { exitCode: number | null; disconnected: boolean }): void };
    const callbacks: Handlers[] = [];
    let counter = 0;
    const connection = {
      available: true,
      connectionId: 'connection',
      close: vi.fn(),
      openShell: async (_size: unknown, handlers: Handlers) => {
        callbacks.push(handlers);
        const sessionId = `session-${++counter}`;
        handlers.output(`early-${counter}\r\n`);
        return {
          sessionId,
          connectionId: 'connection',
          write: vi.fn(),
          resize: vi.fn(),
          close: () => handlers.closed({ exitCode: 0, disconnected: false }),
        };
      },
    } as unknown as SshObservationConnection;
    const terminal = new SshTerminal(
      connection,
      {
        workspaceId: 'w',
        environmentId: 'ssh',
        resourceId: 'ssh-terminal',
        kind: 'terminal',
        instanceId: 'ssh-instance',
        instanceGeneration: 1,
      },
      () => {},
    );
    const first = await terminal.open(80, 24);
    await terminal.close(first.sessionId!);
    const second = await terminal.open(80, 24);
    expect((await terminal.observation!.readScreen()).data.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'early-2' })]),
    );
    await expect(terminal.close(first.sessionId!)).rejects.toThrow('stale');
    expect(terminal.get().state).toBe('running');
    callbacks[0]!.closed({ exitCode: 0, disconnected: false });
    expect(terminal.get().sessionId).toBe(second.sessionId);
    expect(terminal.get().state).toBe('running');
    await terminal.shutdown();
  });
});

it('waits for a starting SSH shell and closes its acquired channel before shutdown resolves', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.fn();
  const terminal = new SshTerminal(
    {
      available: true,
      openShell: async (_size, handlers) => {
        await ready;
        return {
          sessionId: 'owned-shell',
          connectionId: 'owned-connection',
          write: vi.fn(),
          resize: vi.fn(),
          close: () => {
            close();
            handlers.closed({ exitCode: 0, disconnected: false });
          },
        };
      },
    },
    { workspaceId: 'w', environmentId: 'ssh', resourceId: 'terminal', kind: 'terminal', instanceId: 'instance', instanceGeneration: 2 },
    () => {},
  );
  const opening = terminal.open(80, 24);
  let stopped = false;
  const stopping = terminal.shutdown().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await opening;
  await stopping;
  expect(close).toHaveBeenCalledOnce();
  expect(terminal.get()).toMatchObject({ state: 'closed', cleanupPending: false });
  await expect(terminal.observation!.readScreen()).rejects.toThrow('unavailable');
});

it('keeps disconnected remote process cleanup unknown through close and shutdown', async () => {
  let disconnected!: () => void;
  const terminal = new SshTerminal(
    {
      available: true,
      openShell: async (_size, handlers) => {
        disconnected = () => handlers.closed({ exitCode: null, disconnected: true });
        return { sessionId: 'remote', connectionId: 'connection', write: vi.fn(), resize: vi.fn(), close: vi.fn() };
      },
    },
    { workspaceId: 'w', environmentId: 'ssh', resourceId: 'terminal', kind: 'terminal', instanceId: 'instance', instanceGeneration: 1 },
    () => {},
  );
  const opened = await terminal.open(80, 24);
  disconnected();
  expect(terminal.get().cleanupPending).toBe(true);
  await expect(terminal.close(opened.sessionId!)).rejects.toThrow('unknown');
  await expect(terminal.shutdown()).rejects.toThrow('unknown');
});

it('rejects close when the connection is lost while waiting for channel closure', async () => {
  const terminal = new SshTerminal(
    {
      available: true,
      openShell: async (_size, handlers) => ({
        sessionId: 'remote',
        connectionId: 'connection',
        write: vi.fn(),
        resize: vi.fn(),
        close: () => handlers.closed({ exitCode: null, disconnected: true }),
      }),
    },
    { workspaceId: 'w', environmentId: 'ssh', resourceId: 'terminal', kind: 'terminal', instanceId: 'instance', instanceGeneration: 1 },
    () => {},
  );
  const opened = await terminal.open(80, 24);
  await expect(terminal.close(opened.sessionId!)).rejects.toThrow('unknown');
  expect(terminal.get().cleanupPending).toBe(true);
  await expect(terminal.shutdown()).rejects.toThrow('unknown');
});

it('keeps shell startup unknown when transport disconnects before acquisition completes', async () => {
  const connection = { available: false, openShell: vi.fn().mockRejectedValue(new Error('transport disconnected')) };
  const terminal = new SshTerminal(
    connection,
    { workspaceId: 'w', environmentId: 'ssh', resourceId: 'terminal', kind: 'terminal', instanceId: 'instance', instanceGeneration: 1 },
    () => {},
  );
  await expect(terminal.open(80, 24)).rejects.toThrow();
  expect(terminal.get()).toMatchObject({ state: 'failed', cleanupPending: true });
  await expect(terminal.shutdown()).rejects.toThrow('unknown');
});
