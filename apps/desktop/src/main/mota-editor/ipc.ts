import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  MotaEditorReadInputSchema,
  MotaEditorSaveInputSchema,
  MotaEditorCloseInputSchema,
  MotaEditorStatusInputSchema,
} from '@wsl/protocol';
import type { WorkbenchApplication } from '../workbench/application';
import type { MotaEditorController } from './controller';

export function editorSender(event: IpcMainInvokeEvent, owners: Iterable<MotaEditorController>): string {
  for (const owner of owners) if (owner.accepts(event)) return owner.getFacts().resourceId;
  throw new Error('denied: 仅当前可信编辑器顶层文档可调用');
}
/** Deliberately separate from ordinary workbench IPC and its sender whitelist. */
export function registerMotaEditorIpc(application: WorkbenchApplication, owners: () => Iterable<MotaEditorController>): () => void {
  ipcMain.handle('mota-editor:read', (event, input: unknown) =>
    application.readMotaEditorFile(editorSender(event, owners()), MotaEditorReadInputSchema.parse(input)),
  );
  ipcMain.handle('mota-editor:save', (event, input: unknown) =>
    application.saveMotaEditorFile(editorSender(event, owners()), MotaEditorSaveInputSchema.parse(input)),
  );
  ipcMain.handle('mota-editor:close', (event, input: unknown) =>
    application.closeMotaEditor(editorSender(event, owners()), MotaEditorCloseInputSchema.parse(input)),
  );
  ipcMain.handle('mota-editor:status', (event, input: unknown) =>
    application.motaEditorOperationStatus(editorSender(event, owners()), MotaEditorStatusInputSchema.parse(input)),
  );
  return () => {
    for (const name of ['read', 'save', 'close', 'status']) ipcMain.removeHandler('mota-editor:' + name);
  };
}
