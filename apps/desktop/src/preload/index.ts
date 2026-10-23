import { contextBridge, ipcRenderer } from 'electron';
import { DEBUG_PRELOAD_ARGUMENT, eventChannels, invokeChannels } from '@wsl/protocol';
import type { EventChannel, EventPayload, InvokeChannel, InvokeRequest, InvokeResponse, StudioApi, StudioDebugApi } from '@wsl/protocol';

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

const studio: StudioApi & { debug?: StudioDebugApi } = {
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
    catalogCommand: (command) => invoke('workbench:catalog-command', command),
    runPatch: (workspaceId, runId) => invoke('workbench:run-patch', { workspaceId, runId }),
    resourceRevision: (resourceId, version) => invoke('workbench:resource-revision', { resourceId, version }),
    runReferences: (workspaceId, runId) => invoke('workbench:run-references', { workspaceId, runId }),
    command: (command) => invoke('workbench:command', command),
    onEvent: (listener) => subscribe('workbench:event', listener),
  },
  chat: {
    getStatus: () => invoke('chat:get-status'),
    get: (conversationId) => invoke('chat:get', { conversationId }),
    send: (conversationId, text, references = []) => {
      if (conversationId !== 'conv-personal-default') throw new Error('空间会话必须使用所属任务用例');
      return invoke('chat:send', { conversationId, text, references });
    },
    cancel: (conversationId) => invoke('chat:cancel', { conversationId }),
    reset: (conversationId) => invoke('chat:reset', { conversationId }),
    answerPermission: (conversationId, requestId, optionId) => invoke('chat:permission-reply', { conversationId, requestId, optionId }),
    onStatus: (listener) => subscribe('chat:status', listener),
    onConversation: (listener) => subscribe('chat:conversation', listener),
    profiles: {
      get: () => invoke('chat:profiles-get'),
      create: (label) => invoke('chat:profiles-create', { label }),
      check: (profileId) => invoke('chat:profiles-check', { profileId }),
      remove: (profileId) => invoke('chat:profiles-remove', { profileId }),
      setDefault: (selection) => invoke('chat:profiles-default', selection),
      onChange: (listener) => subscribe('chat:profiles', listener),
    },
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

// 诊断接口只在 Main 启用诊断通道时存在：未启用时 `studio` 的键保持不变（status-interface.md §8.1）。
if (process.argv.includes(DEBUG_PRELOAD_ARGUMENT)) {
  studio.debug = {
    status: () => invoke('debug:status'),
    onTransition: (listener) => subscribe('debug:status', listener),
    onFactsChanged: (listener) => subscribe('debug:facts-changed', () => listener()),
    onTogglePanel: (listener) => subscribe('debug:panel', () => listener()),
  };
}

contextBridge.exposeInMainWorld('studio', studio);
