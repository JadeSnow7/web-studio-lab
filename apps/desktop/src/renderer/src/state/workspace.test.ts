import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSnapshot, WorkbenchResult, WorkbenchCommand, WorkspaceSnapshot } from '@wsl/protocol';
import { projectSnapshot, workspaceCommand, workspaceStore, switchWorkspace } from './workspace';
import { locateSession } from './location';
const workspace = (workspaceId: string, revision = 0): WorkspaceSnapshot => ({
  workspaceId,
  name: workspaceId,
  revision,
  tabs: [],
  resources: [],
  layout: { kind: 'pane', paneId: `pane-${workspaceId}`, tabId: null },
  activePaneId: `pane-${workspaceId}`,
  sessions: [],
  runs: [],
  fileHints: [],
  observations: [],
  theme: 'light',
  publicResources: null,
  publicResourcesError: null,
});
const snapshot = (seq: number, appInstanceId = 'epoch-one', revision = 0): WorkbenchSnapshot => ({
  seq,
  appInstanceId,
  activeWorkspaceId: 'A',
  storageError: null,
  notifications: [],
  environments: [],
  notificationReadReceipts: [],
  workspaces: [workspace('A', revision), workspace('B'), workspace('C')],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  workspaceStore.set(() => ({ snapshot: null, selectedId: null, error: null }));
});
describe('空间应用客户端', () => {
  it('资源业务错误仅消费Main投影，失败保留集合，成功重试清Main错误', async () => {
    projectSnapshot(snapshot(1));
    const failed = snapshot(2);
    failed.workspaces[0]!.publicResourcesError = '资源保存失败';
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'execution_failed', message: '资源保存失败' }, snapshot: failed })
      .mockResolvedValueOnce({ ok: true, snapshot: snapshot(3) });
    vi.stubGlobal('window', { studio: { workbench: { command: invoke } } });
    await workspaceCommand('A', { type: 'capturePublicResource', resourceId: 'web' });
    expect(workspaceStore.get().snapshot?.workspaces[0]!.publicResourcesError).toBe('资源保存失败');
    expect(workspaceStore.get().error).toBeNull();
    expect(workspaceStore.get().snapshot?.workspaces[0]!.publicResources).toBeNull();
    await workspaceCommand('A', { type: 'capturePublicResource', resourceId: 'web' });
    expect(workspaceStore.get().error).toBeNull();
    expect(workspaceStore.get().snapshot?.workspaces[0]!.publicResourcesError).toBeNull();
  });
  it('资源成功不能清除并发无关命令的错误，即使文案相同', async () => {
    projectSnapshot(snapshot(1));
    const retry = deferred<WorkbenchResult>();
    let attempts = 0;
    const invoke = vi.fn((c: WorkbenchCommand): Promise<WorkbenchResult> => {
      if (c.type === 'capturePublicResource') {
        attempts++;
        return attempts === 1
          ? Promise.resolve({ ok: false, error: { code: 'execution_failed', message: '失败' }, snapshot: snapshot(2) })
          : retry.promise;
      }
      return Promise.resolve({ ok: false, error: { code: 'execution_failed', message: '失败' }, snapshot: snapshot(3) });
    });
    vi.stubGlobal('window', { studio: { workbench: { command: invoke } } });
    await workspaceCommand('A', { type: 'capturePublicResource', resourceId: 'web' });
    const pending = workspaceCommand('A', { type: 'capturePublicResource', resourceId: 'web' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await workspaceCommand('A', { type: 'browserAction', resourceId: 'other', action: 'reload' });
    retry.resolve({ ok: true, snapshot: snapshot(4) });
    await pending;
    expect(workspaceStore.get().error).toBe('失败');
  });
  it('定位不被旧草稿队列延迟，随后切空间不会被迟到定位覆盖', async () => {
    projectSnapshot(snapshot(1));
    const draft = deferred<WorkbenchResult>();
    const invoke = vi.fn((c: WorkbenchCommand) =>
      c.type === 'saveDraft'
        ? draft.promise
        : Promise.resolve({
            ok: true as const,
            snapshot: { ...snapshot(c.type === 'locateSession' ? 2 : 3), activeWorkspaceId: c.workspaceId },
          }),
    );
    vi.stubGlobal('window', { studio: { workbench: { command: invoke } } });
    const save = workspaceCommand('B', { type: 'saveDraft', sessionId: 'session', draft: 'old' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await locateSession({ workspaceId: 'B', sessionId: 'session', runId: 'run', taskVersionId: 'version', view: 'log' });
    await switchWorkspace('C');
    expect(invoke.mock.calls.map(([c]) => c.type)).toEqual(['saveDraft', 'locateSession', 'switchWorkspace']);
    expect(workspaceStore.get().selectedId).toBe('C');
    draft.resolve({ ok: true, snapshot: snapshot(1) });
    await save;
    expect(workspaceStore.get().selectedId).toBe('C');
    expect(workspaceStore.get().snapshot?.activeWorkspaceId).toBe('C');
  });
  it('初始权威快照恢复所选空间，旧seq及旧epoch事件不能覆盖', () => {
    const initial = { ...snapshot(9), activeWorkspaceId: 'B' };
    projectSnapshot(initial);
    expect(workspaceStore.get().selectedId).toBe('B');
    projectSnapshot(snapshot(8));
    expect(workspaceStore.get().snapshot?.seq).toBe(9);
    projectSnapshot(snapshot(1, 'epoch-two'), true);
    expect(workspaceStore.get().snapshot?.appInstanceId).toBe('epoch-two');
    projectSnapshot(snapshot(999, 'epoch-one'));
    expect(workspaceStore.get().snapshot?.appInstanceId).toBe('epoch-two');
  });
  it('按空间串行元数据，第二保存使用第一保存返回的修订', async () => {
    projectSnapshot(snapshot(1));
    const first = deferred<WorkbenchResult>();
    const invoke = vi.fn((c: WorkbenchCommand) =>
      c.type === 'saveDraft' && c.draft === 'first'
        ? first.promise
        : Promise.resolve({ ok: true as const, snapshot: snapshot(3, 'epoch-one', 2) }),
    );
    vi.stubGlobal('window', { studio: { workbench: { command: invoke } } });
    const a = workspaceCommand('A', { type: 'saveDraft', sessionId: 'session', draft: 'first' });
    const b = workspaceCommand('A', { type: 'saveDraft', sessionId: 'session', draft: 'second' });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls[0]?.[0].expectedRevision).toBe(0);
    first.resolve({ ok: true, snapshot: snapshot(2, 'epoch-one', 1) });
    await Promise.all([a, b]);
    expect(invoke.mock.calls[1]?.[0].expectedRevision).toBe(1);
  });
  it('运行布局成功不会擦除业务失败', async () => {
    projectSnapshot(snapshot(1));
    vi.stubGlobal('window', { studio: { workbench: { command: vi.fn(async () => ({ ok: true, snapshot: snapshot(2) })) } } });
    workspaceStore.set((s) => ({ ...s, error: '版本冲突' }));
    await workspaceCommand('A', { type: 'hideBrowsers' });
    expect(workspaceStore.get().error).toBe('版本冲突');
  });
  it('A→B→C时B迟到响应不会改变观看C或覆盖更新快照', async () => {
    projectSnapshot(snapshot(1));
    const late = deferred<WorkbenchResult>();
    vi.stubGlobal('window', {
      studio: {
        workbench: {
          command: vi.fn((c: WorkbenchCommand) =>
            c.workspaceId === 'B' ? late.promise : Promise.resolve({ ok: true, snapshot: { ...snapshot(3), activeWorkspaceId: 'C' } }),
          ),
        },
      },
    });
    const b = switchWorkspace('B');
    await switchWorkspace('C');
    late.resolve({ ok: true, snapshot: { ...snapshot(2), activeWorkspaceId: 'B' } });
    await b;
    expect(workspaceStore.get().selectedId).toBe('C');
    expect(workspaceStore.get().snapshot?.activeWorkspaceId).toBe('C');
  });
});
