import { contextBridge, ipcRenderer } from 'electron';
import {
  eventChannels,
  invokeChannels,
  ResourceListRequestSchema,
  ResourceCaptureRequestSchema,
  ResourceRemoveRequestSchema,
} from '@wsl/protocol';
import type { EventChannel, EventPayload, InvokeChannel, InvokeRequest, InvokeResponse, StudioApi } from '@wsl/protocol';

// preload 只把具名方法交给工作台页面，不暴露 ipcRenderer 本身。
function invoke<C extends InvokeChannel>(channel: C, request?: InvokeRequest<C>): Promise<InvokeResponse<C>> {
  return ipcRenderer.invoke(channel, request).then((raw: unknown) => invokeChannels[channel].response.parse(raw)) as Promise<
    InvokeResponse<C>
  >;
}

function subscribe<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: EventPayload<C>) =>
    listener(eventChannels[channel].parse(payload) as EventPayload<C>);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const studio: StudioApi = {
  resources: {
    list: (spaceId) => invoke('resources:list', ResourceListRequestSchema.parse({ spaceId })),
    capture: (spaceId, expectedPage, resourceId) =>
      invoke('resources:capture', ResourceCaptureRequestSchema.parse({ spaceId, expectedPage, resourceId })),
    remove: (spaceId, resourceId) => invoke('resources:remove', ResourceRemoveRequestSchema.parse({ spaceId, resourceId })),
  },
  chat: {
    getStatus: () => invoke('chat:get-status'),
    get: (conversationId) => invoke('chat:get', { conversationId }),
    send: (conversationId, text) => invoke('chat:send', { conversationId, text }),
    cancel: (conversationId) => invoke('chat:cancel', { conversationId }),
    reset: (conversationId) => invoke('chat:reset', { conversationId }),
    onStatus: (listener) => subscribe('chat:status', listener),
    onConversation: (listener) => subscribe('chat:conversation', listener),
  },
  terminal: {
    get: () => invoke('terminal:get'),
    open: (cols, rows) => invoke('terminal:open', { cols, rows }),
    write: (sessionId, data) => invoke('terminal:write', { sessionId, data }),
    resize: (sessionId, cols, rows) => invoke('terminal:resize', { sessionId, cols, rows }),
    close: (sessionId) => invoke('terminal:close', { sessionId }),
    onState: (listener) => subscribe('terminal:state', listener),
  },
  preview: {
    getState: () => invoke('preview:get-state'),
    setLayout: (layout) => invoke('preview:set-layout', layout),
    freeze: () => invoke('preview:freeze'),
    navigate: (url) => invoke('preview:navigate', { url }),
    reload: () => invoke('preview:reload'),
    goBack: () => invoke('preview:go-back'),
    goForward: () => invoke('preview:go-forward'),
    focus: () => invoke('preview:focus'),
    startPick: () => invoke('preview:start-pick'),
    cancelPick: () => invoke('preview:cancel-pick'),
    reattachCdp: () => invoke('preview:reattach-cdp'),
    onState: (listener) => subscribe('preview:state', listener),
    onCaptured: (listener) => subscribe('preview:captured', listener),
  },
  app: {
    getInfo: () => invoke('app:get-info'),
  },
  execution: {
    getStatus: () => invoke('execution:get-status'),
  },
  shell: {
    onCommand: (listener) => subscribe('shell:command', listener),
  },
};

contextBridge.exposeInMainWorld('studio', studio);
