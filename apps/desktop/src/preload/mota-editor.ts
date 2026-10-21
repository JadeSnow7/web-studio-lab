import { contextBridge, ipcRenderer } from 'electron';
import type { MotaEditorBridge, MotaEditorProjection } from '@wsl/protocol';

const bridge: MotaEditorBridge = {
  read: (input) => ipcRenderer.invoke('mota-editor:read', input),
  save: (input) => ipcRenderer.invoke('mota-editor:save', input),
  close: (input) => ipcRenderer.invoke('mota-editor:close', input),
  status: (input) => ipcRenderer.invoke('mota-editor:status', input),
  onState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, projection: MotaEditorProjection) => listener(projection);
    ipcRenderer.on('mota-editor:status', receive);
    return () => ipcRenderer.removeListener('mota-editor:status', receive);
  },
};
contextBridge.exposeInMainWorld('motaEditor', bridge);
