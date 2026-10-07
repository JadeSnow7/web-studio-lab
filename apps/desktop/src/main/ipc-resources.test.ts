import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpc, type IpcDeps } from './ipc';
import type { PageResourceSnapshot } from '@wsl/protocol';

const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>());
vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, request: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
const page = { webContentsId: 9, documentGeneration: 2, url: 'https://example.com/', title: 'Example', partition: 'preview' };
const snapshot: PageResourceSnapshot = {
  page,
  requestedUrl: page.url,
  url: page.url,
  title: page.title,
  text: 'trusted capture',
  capturedAt: '2026-10-06T12:00:00.000Z',
  sourceSha256: '0'.repeat(64),
  contentSha256: '1'.repeat(64),
  extractionVersion: 'html-text-v1',
  truncated: false,
};
const frame = { url: 'file:///renderer/index.html' };
const webContents = { mainFrame: frame };
const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
let capture: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handlers.clear();
  capture = vi.fn().mockResolvedValue(snapshot);
  save = vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] });
  registerIpc({
    window: { isDestroyed: () => false, webContents },
    preview: { captureResource: capture },
    chat: { resourcesSave: save },
    trusted: { kind: 'file', url: frame.url },
  } as unknown as IpcDeps);
});
const request = { spaceId: 'taskflow-demo', expectedPage: page };
describe('挂载资源的 main IPC 权威边界', () => {
  it('只把主进程实际捕获的正文交给服务，renderer 只申报页面身份', async () => {
    await handlers.get('resources:capture')!(event, request);
    expect(capture).toHaveBeenCalledWith(page);
    expect(save).toHaveBeenCalledWith('taskflow-demo', snapshot, undefined);
    expect(() => handlers.get('resources:capture')!(event, { ...request, snapshot: { text: 'forged' } })).toThrow();
    expect(save).toHaveBeenCalledOnce();
  });
  it('公开预览 webContents 即使知道通道与正确参数也不能调用资源 IPC', () => {
    const untrusted = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(() => handlers.get('resources:capture')!(untrusted, request)).toThrow('非工作台');
    expect(capture).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('页面导航身份校验失败时，不持久化任何快照', async () => {
    capture.mockRejectedValueOnce(new Error('页面已导航'));
    await expect(handlers.get('resources:capture')!(event, request)).rejects.toThrow('页面已导航');
    expect(save).not.toHaveBeenCalled();
  });
});
