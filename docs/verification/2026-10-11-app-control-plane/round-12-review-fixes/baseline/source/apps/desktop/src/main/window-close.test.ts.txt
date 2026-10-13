import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (event: { preventDefault(): void }) => void>(),
  close: vi.fn(),
  shutdown: vi.fn(),
  getSnapshot: vi.fn(),
  dispose: vi.fn(),
  dialog: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve(), on: vi.fn(), getPath: () => '/tmp', getAppPath: () => '/desktop' },
  dialog: { showMessageBox: fixture.dialog },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
}));
vi.mock('./chat-service', () => ({
  ChatService: class {
    setObservationReader = vi.fn();
    setAppControlReader = vi.fn();
    shutdown = fixture.shutdown;
  },
}));
vi.mock('./workbench/application', () => ({
  WorkbenchApplication: class {
    getSnapshot = fixture.getSnapshot;
    setAppControl = vi.fn();
  },
}));
vi.mock('./workbench/repository', () => ({ FileWorkbenchRepository: class {} }));
vi.mock('./workbench/host', () => ({
  WorkbenchHost: class {
    dispose = fixture.dispose;
  },
}));
vi.mock('./window', () => ({
  rendererSource: vi.fn(),
  createMainWindow: () => ({
    on: (name: string, callback: (event: { preventDefault(): void }) => void) => fixture.listeners.set(name, callback),
    close: fixture.close,
  }),
}));
vi.mock('./ipc', () => ({ registerIpc: () => vi.fn(), sendToRenderer: vi.fn() }));
vi.mock('./menu', () => ({ installAppMenu: vi.fn() }));
vi.mock('./preview/demo-protocol', () => ({ registerDemoScheme: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  fixture.listeners.clear();
  vi.clearAllMocks();
  fixture.shutdown.mockResolvedValue(undefined);
  fixture.dialog.mockResolvedValue({ response: 1 });
  fixture.getSnapshot.mockRejectedValue(new Error('corrupt workspace file'));
});
describe('window shutdown', () => {
  async function open() {
    await import('./index');
    await vi.waitFor(() => expect(fixture.listeners.has('close')).toBe(true));
  }
  function close() {
    fixture.listeners.get('close')?.({ preventDefault: vi.fn() });
  }
  it('closes after confirmed guest cleanup even when the workbench is unreadable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await open();
    close();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.getSnapshot).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('继续关闭窗口'), expect.any(Error));
    expect(fixture.dialog).not.toHaveBeenCalled();
    error.mockRestore();
  });
  it('waits for Main persistence queue after service cleanup before closing', async () => {
    let complete!: () => void;
    fixture.getSnapshot.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await open();
    close();
    await vi.waitFor(() => expect(fixture.getSnapshot).toHaveBeenCalledOnce());
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  });
  it('keeps the window open and shows the concrete cause when cancel is selected', async () => {
    fixture.shutdown.mockRejectedValue(new Error('registry sandbox:null'));
    await open();
    close();
    await vi.waitFor(() => expect(fixture.dialog).toHaveBeenCalledOnce());
    expect(fixture.dialog.mock.calls[0]?.[1]).toMatchObject({ detail: expect.stringContaining('registry sandbox:null'), defaultId: 1 });
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(fixture.getSnapshot).not.toHaveBeenCalled();
  });
  it('retries cleanup from the dialog and closes after confirmation', async () => {
    fixture.shutdown.mockRejectedValueOnce(new Error('registry broken')).mockResolvedValueOnce(undefined);
    fixture.dialog.mockResolvedValue({ response: 0 });
    await open();
    close();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledTimes(2);
    expect(fixture.dialog).toHaveBeenCalledOnce();
  });
  it('only explicit still-exit permits closure after cleanup failure', async () => {
    fixture.shutdown.mockRejectedValue(new Error('unknown process'));
    fixture.dialog.mockResolvedValue({ response: 2 });
    await open();
    close();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });
  it('repeated close events join one in-flight cleanup and do not show duplicate dialogs', async () => {
    let reject!: (error: Error) => void;
    fixture.shutdown.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    await open();
    close();
    close();
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce());
    reject(new Error('cleanup unknown'));
    await vi.waitFor(() => expect(fixture.dialog).toHaveBeenCalledOnce());
    expect(fixture.close).not.toHaveBeenCalled();
  });
});
