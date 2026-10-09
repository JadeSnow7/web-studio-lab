import { contextBridge, ipcRenderer } from 'electron';
import { eventChannels, invokeChannels } from '@wsl/protocol';
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
  setup: {
    status: () => invoke('setup:status'),
    check: () => invoke('setup:check'),
    prepare: () => invoke('setup:prepare'),
    retry: () => invoke('setup:retry'),
    cancel: () => invoke('setup:cancel'),
    login: (provider, acknowledgeGlobalCredentials) => invoke('setup:login', { provider, acknowledgeGlobalCredentials }),
    save: (settings) => invoke('setup:save', settings),
    chooseRoot: () => invoke('setup:choose-root'),
    onStatus: (listener) => subscribe('setup:status', listener),
  },
  workbench: {
    environments: () => invoke('workbench:environments'),
    observe: (input) => invoke('workbench:observe', input),
    reload: () => invoke('workbench:reload'),
    getSnapshot: () => invoke('workbench:get-snapshot'),
    command: (command) => invoke('workbench:command', command),
    onEvent: (listener) => subscribe('workbench:event', listener),
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
