import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (event: { preventDefault(): void }) => void>(),
  close: vi.fn(),
  shutdown: vi.fn(),
  getSnapshot: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve(), on: vi.fn(), getPath: () => '/tmp', getAppPath: () => '/desktop' },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
}));
vi.mock('./chat-service', () => ({
  ChatService: class {
    shutdown = fixture.shutdown;
  },
}));
vi.mock('./workbench/application', () => ({
  WorkbenchApplication: class {
    getSnapshot = fixture.getSnapshot;
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
  fixture.getSnapshot.mockRejectedValue(new Error('corrupt workspace file'));
});
describe('window shutdown after unreadable workspace', () => {
  it('closes after confirmed guest cleanup even when workbench initialization failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('./index');
    await vi.waitFor(() => expect(fixture.listeners.has('close')).toBe(true));
    fixture.listeners.get('close')?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('继续关闭窗口'), expect.any(Error));
    error.mockRestore();
  });
  it('keeps the window open when guest cleanup remains unconfirmed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fixture.shutdown.mockRejectedValue(new Error('cleanup unknown'));
    await import('./index');
    await vi.waitFor(() => expect(fixture.listeners.has('close')).toBe(true));
    fixture.listeners.get('close')?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.getSnapshot).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
