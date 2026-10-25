import { beforeEach, expect, it, vi } from 'vitest';
import { WorkbenchSnapshotSchema, WorkspaceSnapshotSchema, type EnvironmentDescription } from '@wsl/protocol';
import * as workspace from './workspace';
import { spaceActions, spaceUiStore } from './space-ui';
import { createTab } from './new-tab';
import { readEnvironmentPreference } from './default-environment';
vi.mock('./shortcuts', () => ({ createWebTab: vi.fn() }));
vi.mock('./errors', () => ({ reportError: vi.fn() }));
vi.mock('./space-ui', async () => {
  const { createStore } = await import('../lib/store');
  return { spaceActions: { openEditor: vi.fn() }, spaceUiStore: createStore({ editor: null }) };
});
const environment: EnvironmentDescription = {
  environmentId: 'local',
  kind: 'local',
  label: '本机',
  state: 'configured',
  reason: null,
  capabilities: { files: true, terminal: true, browser: true },
};
const space = () =>
  WorkspaceSnapshotSchema.parse({
    workspaceId: 'a',
    name: 'A',
    revision: 0,
    theme: 'light',
    tabs: [],
    resources: [],
    sessions: [],
    runs: [],
    layout: { kind: 'pane', paneId: 'p', tabId: null },
    activePaneId: 'p',
  });
const snapshot = () => {
  const value = workspace.workspaceStore.get().snapshot;
  if (!value) throw new Error('missing fixture snapshot');
  return value;
};
let storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const data = new Map<string, string>();
  storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { studio: { workbench: { environments: vi.fn().mockResolvedValue([environment]) } } });
  const snapshot = WorkbenchSnapshotSchema.parse({
    appInstanceId: 'app',
    storageError: null,
    activeWorkspaceId: 'a',
    seq: 0,
    workspaces: [space()],
  });
  workspace.workspaceStore.set(() => ({ snapshot, selectedId: 'a', error: null }));
});
it('records a default only after a successful creation, preventing duplicate in-flight creation', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = vi.spyOn(workspace, 'workspaceCommand').mockImplementation(async () => {
    await gate;
    return null;
  });
  const first = createTab('terminal');
  await Promise.resolve();
  await Promise.resolve();
  await createTab('terminal');
  expect(readEnvironmentPreference(storage, 'a', 'terminal')).toBeNull();
  expect(command).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(readEnvironmentPreference(storage, 'a', 'terminal')).toBeNull();
  command.mockResolvedValue({ ok: true, snapshot: snapshot() });
  await createTab('terminal');
  expect(readEnvironmentPreference(storage, 'a', 'terminal')).toBe('local');
  expect(command).toHaveBeenLastCalledWith('a', { type: 'createTab', kind: 'terminal', title: '终端 · 本机', environmentId: 'local' });
});
it('does not apply a delayed environment result after changing space, navigation or opening an editor', async () => {
  const command = vi.spyOn(workspace, 'workspaceCommand');
  for (const invalidate of [
    () => workspace.workspaceStore.set((s) => ({ ...s, selectedId: 'b' })),
    () => workspace.beginNavigation(),
    () => spaceUiStore.set((s) => ({ ...s })),
  ]) {
    workspace.workspaceStore.set((s) => ({ ...s, selectedId: 'a' }));
    let resolve: (value: (typeof environment)[]) => void = () => {};
    vi.mocked(window.studio.workbench.environments).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const creating = createTab('terminal');
    invalidate();
    resolve([environment]);
    await creating;
  }
  expect(command).not.toHaveBeenCalled();
  expect(spaceActions.openEditor).not.toHaveBeenCalled();
});
it('uses an explicit form when a previously successful environment is unavailable; does not silently replace it', async () => {
  storage.setItem('wsl.default-environment:a:terminal', 'sandbox');
  const command = vi.spyOn(workspace, 'workspaceCommand');
  await createTab('terminal');
  expect(command).not.toHaveBeenCalled();
  expect(spaceActions.openEditor).toHaveBeenCalledWith({ kind: 'tab', tabKind: 'terminal' }, '终端');
});
it('records success against the frozen original space when the user switches while creation is saving', async () => {
  vi.spyOn(workspace, 'workspaceCommand').mockImplementation(async () => {
    workspace.workspaceStore.set((s) => ({ ...s, selectedId: 'b' }));
    return { ok: true, snapshot: snapshot() };
  });
  await createTab('terminal');
  expect(readEnvironmentPreference(storage, 'a', 'terminal')).toBe('local');
  expect(readEnvironmentPreference(storage, 'b', 'terminal')).toBeNull();
});
