import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpc, type IpcDeps } from './ipc';
const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>());
vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, request: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
const frame = { url: 'file:///renderer/index.html' };
const webContents = { mainFrame: frame };
const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
let capture: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handlers.clear();
  capture = vi.fn().mockResolvedValue({
    ok: true,
    snapshot: { appInstanceId: 'test', storageError: null, activeWorkspaceId: 'taskflow-demo', seq: 0, workspaces: [] },
  });
  registerIpc({
    window: { isDestroyed: () => false, webContents },
    chat: {},
    workbench: { command: capture },
    trusted: { kind: 'file', url: frame.url },
  } as unknown as IpcDeps);
});
const request = { type: 'capturePublicResource', commandId: 'capture', workspaceId: 'taskflow-demo', resourceId: 'web-resource' };
describe('公开资源 main IPC 权威边界', () => {
  it('accepts only stable resource identity; renderer cannot inject captured content', async () => {
    await handlers.get('workbench:command')?.(event, request);
    expect(capture).toHaveBeenCalledWith(request);
    expect(() => handlers.get('workbench:command')?.(event, { ...request, snapshot: { text: 'forged' } })).toThrow();
    expect(capture).toHaveBeenCalledOnce();
  });
  it('rejects a preview webContents even when it knows a valid command', () => {
    const untrusted = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(() => handlers.get('workbench:command')?.(untrusted, request)).toThrow('非工作台');
    expect(capture).not.toHaveBeenCalled();
  });
  it('does not turn navigation capture failure into a successful save', async () => {
    capture.mockRejectedValueOnce(new Error('页面已导航'));
    await expect(handlers.get('workbench:command')?.(event, request)).rejects.toThrow('页面已导航');
    expect(handlers.has('resources:capture')).toBe(false);
    expect(handlers.has('preview:navigate')).toBe(false);
  });
  it('rejects the retired space-chat slot and dynamic slots on every legacy chat command', () => {
    for (const channel of ['chat:get', 'chat:send', 'chat:cancel', 'chat:reset'])
      for (const conversationId of ['conv-space-taskflow-demo-impl', 'session-dynamic']) {
        expect(() => handlers.get(channel)?.(event, { conversationId, ...(channel === 'chat:send' ? { text: 'bypass' } : {}) })).toThrow(
          '任务用例',
        );
      }
  });
});
