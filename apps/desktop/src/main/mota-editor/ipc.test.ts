import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { WorkbenchApplication } from '../workbench/application';
import { MotaEditorController } from './controller';
import { registerMotaEditorIpc } from './ipc';
const handlers = vi.hoisted(() => new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name),
  },
}));
describe('separate editor-only IPC boundary', () => {
  it('registers exactly four strict channels and derives resource from the native owner', async () => {
    const application = vi.mockObject(WorkbenchApplication.prototype);
    const owner = vi.mockObject(MotaEditorController.prototype);
    const event = {} as IpcMainInvokeEvent;
    owner.accepts.mockImplementation((candidate) => candidate === event);
    owner.getFacts.mockReturnValue({ resourceId: 'owned-resource' } as ReturnType<MotaEditorController['getFacts']>);
    const unregister = registerMotaEditorIpc(application, () => [owner]);
    expect([...handlers.keys()].sort()).toEqual(['mota-editor:close', 'mota-editor:read', 'mota-editor:save', 'mota-editor:status']);
    const input = { sessionIndex: 1, file: '_server/config.json', requestId: randomUUID() };
    await handlers.get('mota-editor:read')!(event, input);
    expect(application.readMotaEditorFile).toHaveBeenCalledWith('owned-resource', input);
    expect(() => handlers.get('mota-editor:read')!({} as IpcMainInvokeEvent, input)).toThrow('denied');
    expect(() => handlers.get('mota-editor:read')!(event, { ...input, projectId: randomUUID(), root: '/host' })).toThrow();
    expect(() =>
      handlers.get('mota-editor:save')!(event, { ...input, file: 'project/floors/MT2.js', expectedHash: null, content: '{}' }),
    ).toThrow();
    unregister();
    expect(handlers.size).toBe(0);
  });
});
