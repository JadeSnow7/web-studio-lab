import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResearchCall, ResearchReply } from '@wsl/protocol';
import type { registerMotaEditorIpc } from './mota-editor/ipc';
const fixture = vi.hoisted(() => ({
  listeners: new Map<string, (event: { preventDefault(): void }) => void>(),
  close: vi.fn(),
  shutdown: vi.fn(),
  setupShutdown: vi.fn(),
  workbenchShutdown: vi.fn(),
  deactivateAudio: vi.fn<() => Promise<void>>(),
  resumeAudio: vi.fn<() => Promise<void>>(),
  getSnapshot: vi.fn(),
  dispose: vi.fn(),
  registerSchemesAsPrivileged: vi.fn(),
  registerMotaEditorIpc: vi.fn<typeof registerMotaEditorIpc>(),
  unregisterMotaEditorIpc: vi.fn(),
  motaEditors: new Map<string, never>(),
  hideMotaEditors: vi.fn(),
  dialog: vi.fn(),
  setResearchReader: vi.fn<(reader: (call: ResearchCall, signal: AbortSignal) => Promise<ResearchReply>) => void>(),
  researchForTurn: vi.fn<(call: ResearchCall, signal: AbortSignal) => Promise<ResearchReply>>(),
}));
vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve(), on: vi.fn(), getPath: () => '/tmp', getAppPath: () => '/desktop' },
  dialog: { showMessageBox: fixture.dialog },
  protocol: { registerSchemesAsPrivileged: fixture.registerSchemesAsPrivileged },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
}));
vi.mock('./setup', () => ({
  SetupManager: {
    open: async () => ({
      runtimeConfig: () => ({
        schemaVersion: 1,
        sbxBinary: null,
        sandbox: null,
        pythonBinary: '/fixture/python',
        localRoot: null,
        ssh: null,
      }),
      subscribe: () => vi.fn(),
      shutdown: fixture.setupShutdown,
    }),
  },
}));
vi.mock('./setup-adapter', () => ({ NativeSetupAdapter: class {} }));
vi.mock('./chat-service', () => ({
  ChatService: class {
    setObservationReader = vi.fn();
    setAppControlReader = vi.fn();
    setResearchReader = fixture.setResearchReader;
    shutdown = fixture.shutdown;
  },
}));
vi.mock('./workbench/application', () => ({
  WorkbenchApplication: class {
    getSnapshot = fixture.getSnapshot;
    shutdown = fixture.workbenchShutdown;
    setAppControl = vi.fn();
    researchForTurn = fixture.researchForTurn;
  },
}));
vi.mock('./workbench/repository', () => ({ FileWorkbenchRepository: class {} }));
// These composition doubles must not register native IPC or touch the operation journal.
vi.mock('./workbench/mota-editor-repository', () => ({ FileMotaEditorOperationStore: class {} }));
vi.mock('./mota-editor/ipc', () => ({ registerMotaEditorIpc: fixture.registerMotaEditorIpc }));
vi.mock('./workbench/host', () => ({
  WorkbenchHost: class {
    motaEditors = fixture.motaEditors;
    hideMotaEditors = fixture.hideMotaEditors;
    dispose = fixture.dispose;
    deactivateAudio = fixture.deactivateAudio;
    resumeAudio = fixture.resumeAudio;
  },
}));
vi.mock('./window', () => ({
  // 返回 file 来源：index.ts 据此判定诊断通道未启用（真实实现同样如此）。
  rendererSource: vi.fn(() => ({ kind: 'file', url: 'file:///app/renderer/index.html' })),
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
  fixture.registerMotaEditorIpc.mockReturnValue(fixture.unregisterMotaEditorIpc);
  fixture.shutdown.mockResolvedValue(undefined);
  fixture.setupShutdown.mockReset().mockResolvedValue(undefined);
  fixture.workbenchShutdown.mockReset().mockResolvedValue(undefined);
  fixture.deactivateAudio.mockResolvedValue(undefined);
  fixture.resumeAudio.mockResolvedValue(undefined);
  fixture.dialog.mockResolvedValue({ response: 1 });
  fixture.getSnapshot.mockRejectedValue(new Error('corrupt workspace file'));
  fixture.researchForTurn.mockReset();
});
describe('window shutdown', () => {
  async function open() {
    await import('./index');
    await vi.waitFor(() => expect(fixture.listeners.has('close')).toBe(true));
  }
  function close() {
    fixture.listeners.get('close')?.({ preventDefault: vi.fn() });
  }
  it('binds the research reader to Main with the exact call and cancellation signal', async () => {
    await open();
    expect(fixture.setResearchReader).toHaveBeenCalledOnce();
    const reader = fixture.setResearchReader.mock.calls[0]![0];
    const call: ResearchCall = {
      callId: 'a15eb090-5465-4f9b-9ccc-499799b0de30',
      context: {
        grant: {
          grantId: 'ef35c4ba-497b-44c6-aaf6-1ae4448c0bc5',
          accountId: 'account',
          workspaceId: 'workspace',
          sessionId: 'session-test',
          taskVersionId: 'version',
          runId: 'run',
          mode: 'live',
          purpose: 'public-web-research',
          grantedAt: '2026-10-15T00:00:00.000Z',
        },
        generation: 'generation',
        turnId: 'turn',
      },
      tool: 'research.open',
      args: { url: 'https://www.wikipedia.org/' },
    };
    const reply: ResearchReply = {
      callId: call.callId,
      context: call.context,
      result: { ok: false, tool: call.tool, error: { code: 'blocked', message: 'HTTP 403' } },
    };
    const pending = Promise.resolve(reply);
    fixture.researchForTurn.mockReturnValue(pending);
    const signal = new AbortController().signal;
    expect(reader(call, signal)).toBe(pending);
    expect(fixture.researchForTurn).toHaveBeenCalledOnce();
    expect(fixture.researchForTurn.mock.calls[0]![0]).toBe(call);
    expect(fixture.researchForTurn.mock.calls[0]![1]).toBe(signal);
    await expect(pending).resolves.toBe(reply);
  });
  it('closes after confirmed guest cleanup even when the workbench is unreadable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await open();
    expect(fixture.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
      { scheme: 'wsl-editor', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
    expect(fixture.registerMotaEditorIpc).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shutdown: fixture.workbenchShutdown }),
      expect.any(Function),
    );
    expect([...fixture.registerMotaEditorIpc.mock.calls[0]![1]()]).toEqual([]);
    close();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.hideMotaEditors).toHaveBeenCalledOnce();
    expect(fixture.hideMotaEditors.mock.invocationCallOrder[0]).toBeLessThan(fixture.deactivateAudio.mock.invocationCallOrder[0]!);
    expect(fixture.unregisterMotaEditorIpc).toHaveBeenCalledOnce();
    expect(fixture.dispose.mock.invocationCallOrder[0]).toBeLessThan(fixture.unregisterMotaEditorIpc.mock.invocationCallOrder[0]!);
    expect(fixture.unregisterMotaEditorIpc.mock.invocationCallOrder[0]).toBeLessThan(fixture.close.mock.invocationCallOrder[0]!);
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
  it('keeps the service available until workbench ending-source operations settle', async () => {
    let finish: (() => void) | undefined;
    fixture.workbenchShutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    fixture.getSnapshot.mockResolvedValue(undefined);
    await open();
    close();
    await vi.waitFor(() => expect(fixture.workbenchShutdown).toHaveBeenCalledOnce());
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    if (!finish) throw new Error('workbench cleanup fixture was not invoked');
    finish();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.dialog).not.toHaveBeenCalled();
  });
  it('still tries service cleanup after workbench cleanup fails, preserving the failure dialog', async () => {
    fixture.workbenchShutdown.mockRejectedValue(new Error('source cleanup unknown'));
    await open();
    close();
    await vi.waitFor(() => expect(fixture.dialog).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.dialog.mock.calls[0]?.[1]).toMatchObject({ detail: expect.stringContaining('source cleanup unknown'), defaultId: 1 });
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
  });
  it('still drains workbench and service when the independent setup owner fails', async () => {
    fixture.setupShutdown.mockRejectedValue(new Error('setup cleanup unknown'));
    await open();
    close();
    await vi.waitFor(() => expect(fixture.dialog).toHaveBeenCalledOnce());
    expect(fixture.workbenchShutdown).toHaveBeenCalledOnce();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.dialog.mock.calls[0]?.[1]).toMatchObject({ detail: expect.stringContaining('setup cleanup unknown') });
    expect(fixture.close).not.toHaveBeenCalled();
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
    expect(fixture.unregisterMotaEditorIpc).not.toHaveBeenCalled();
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
  it('waits for audio release, then workbench source settlement, before service shutdown', async () => {
    let ended!: () => void;
    let settled!: () => void;
    fixture.deactivateAudio.mockImplementation(
      () =>
        new Promise((resolve) => {
          ended = resolve;
        }),
    );
    fixture.workbenchShutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settled = resolve;
        }),
    );
    fixture.getSnapshot.mockResolvedValue(undefined);
    await open();
    close();
    await vi.waitFor(() => expect(fixture.deactivateAudio).toHaveBeenCalledOnce());
    expect(fixture.workbenchShutdown).not.toHaveBeenCalled();
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    ended();
    await vi.waitFor(() => expect(fixture.workbenchShutdown).toHaveBeenCalledOnce());
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    settled();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.getSnapshot).toHaveBeenCalledOnce();
    expect(fixture.dialog).not.toHaveBeenCalled();
  });
  it('reports unconfirmed audio release while still reclaiming the guest and closing after confirmation', async () => {
    const failure = new Error('audio tracks unconfirmed; preview destroyed');
    fixture.deactivateAudio.mockRejectedValue(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await open();
    close();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('退出前音轨核验失败'), failure);
    error.mockRestore();
  });
});
