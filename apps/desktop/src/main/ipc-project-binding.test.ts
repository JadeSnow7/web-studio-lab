import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpc, type IpcDeps } from './ipc';
import type { TrustedRenderer } from './ipc-guard';

/*
 * OPS-1 B1 / O05f：renderer 只能提交 appId | null 与 captureId | null。附带工程路径、完整 App 对象或冻结目标的
 * workbench 命令在 IPC 边界被严格 schema 拒绝，不进入工作台用例；缺少这两个字段的 confirmTask 同样拒绝（不默认推断）。
 */
const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, request: unknown) => unknown>());
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', isPackaged: false },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, request: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const FILE: TrustedRenderer = { kind: 'file', url: 'file:///renderer/index.html' };
const frame = { url: FILE.url };
const mainContents = { mainFrame: frame };
const trustedEvent = { sender: mainContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const snapshot = {
  appInstanceId: 'app',
  storageError: null,
  activeWorkspaceId: 'A',
  seq: 0,
  workspaces: [],
  environments: [],
  notificationReadReceipts: [],
  notifications: [],
};
const command = vi.fn(async () => ({ ok: true, snapshot }));
beforeEach(() => {
  handlers.clear();
  command.mockClear();
  registerIpc({
    window: { isDestroyed: () => false, webContents: mainContents },
    chat: {},
    trusted: FILE,
    workbench: { command },
  } as unknown as IpcDeps);
});
const invoke = (request: unknown) =>
  Promise.resolve().then(() => {
    const handler = handlers.get('workbench:command');
    if (!handler) throw new Error('workbench:command 未注册');
    return handler(trustedEvent, request);
  });
const appId = '50000000-0000-4000-8000-000000000001';
const projectId = '50000000-0000-4000-8000-000000000002';
const base = { commandId: 'c', workspaceId: 'A' };
const confirm = { ...base, type: 'confirmTask', sessionId: 's', goal: '目标', targetRef: null, appId, captureId: null };

describe('workbench:command 工程与页面引用边界（O05f）', () => {
  it('accepts only appId | null and captureId | null', async () => {
    await expect(invoke({ ...base, type: 'saveTaskProject', sessionId: 's', appId })).resolves.toMatchObject({ ok: true });
    await expect(invoke({ ...base, type: 'saveTaskProject', sessionId: 's', appId: null })).resolves.toMatchObject({ ok: true });
    await expect(invoke(confirm)).resolves.toMatchObject({ ok: true });
    await expect(
      invoke({ ...confirm, appId: null, captureId: 'capture-1', targetRef: { kind: 'web', resourceId: 'r' } }),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(command).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['saveTaskProject with a project path', { ...base, type: 'saveTaskProject', sessionId: 's', appId, guestCwd: '/guest/project' }],
    ['saveTaskProject with projectId', { ...base, type: 'saveTaskProject', sessionId: 's', appId, projectId }],
    [
      'saveTaskProject with a full App object',
      {
        ...base,
        type: 'saveTaskProject',
        sessionId: 's',
        appId: { appId, workspaceId: 'A', projectId, name: 'App', description: '', revision: 0 },
      },
    ],
    ['saveTaskProject with a non-uuid appId', { ...base, type: 'saveTaskProject', sessionId: 's', appId: '/guest/project' }],
    ['confirmTask with a project path', { ...confirm, guestCwd: '/guest/project' }],
    [
      'confirmTask with a frozen appTarget',
      { ...confirm, appTarget: { appId, workspaceId: 'A', projectId, name: 'App', description: '', revision: 0, guestCwd: '/x' } },
    ],
    ['confirmTask with a page capture object', { ...confirm, capture: { captureId: 'c' } }],
    ['confirmTask without appId', (({ appId: _appId, ...rest }) => rest)(confirm)],
    ['confirmTask without captureId', (({ captureId: _captureId, ...rest }) => rest)(confirm)],
    ['confirmTask with an empty captureId', { ...confirm, captureId: '' }],
  ])('rejects %s before the workbench sees it', async (_name, request) => {
    await expect(invoke(request)).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });
});
