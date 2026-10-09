import type { SetupManager } from './setup';
import type { WorkbenchApplication } from './workbench/application';
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  INVOKE_CHANNEL_NAMES,
  invokeChannels,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
} from '@wsl/protocol';
import type { ChatService } from './chat-service';
import { getExecutionStatus } from './execution';
import { assertTrustedSender, type TrustedRenderer } from './ipc-guard';

type Handlers = {
  [C in InvokeChannel]: (request: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

export interface IpcDeps {
  window: BrowserWindow;
  trusted: TrustedRenderer;
  chat: ChatService;
  workbench?: WorkbenchApplication;
  setup?: SetupManager;
}

function senderInfo(event: IpcMainInvokeEvent, window: BrowserWindow) {
  const frame = event.senderFrame;
  return {
    isMainWindow: !window.isDestroyed() && event.sender === window.webContents,
    isTopFrame: frame !== null && frame === event.sender.mainFrame,
    frameUrl: frame?.url ?? null,
  };
}

function assertLegacySession(id: string) {
  if (id !== 'conv-personal-default') throw new Error('会话必须通过所属空间任务用例访问');
}

export function registerIpc({ window, trusted, chat, workbench, setup }: IpcDeps): () => void {
  const requireSetup = () => {
    if (!setup) throw new Error('安装服务不可用');
    return setup;
  };
  const handlers: Handlers = {
    'setup:status': () => requireSetup().status(),
    'setup:check': () => requireSetup().check(),
    'setup:prepare': () => requireSetup().prepare(),
    'setup:retry': () => requireSetup().retry(),
    'setup:cancel': () => requireSetup().cancel(),
    'setup:login': ({ provider, acknowledgeGlobalCredentials }) => requireSetup().login(provider, acknowledgeGlobalCredentials),
    'setup:save': (settings) => requireSetup().save(settings),
    'setup:choose-root': async () => {
      requireSetup();
      const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '授权本地文件与终端目录' });
      const root = selected.canceled ? null : (selected.filePaths[0] ?? null);
      if (root) requireSetup().authorizeLocalRoot(root);
      return root;
    },
    'workbench:environments': () => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.environments();
    },
    'workbench:observe': (input) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.observe({ ...input, args: input.args ?? {} });
    },
    'workbench:reload': () => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.retryInitialization();
    },
    'workbench:get-snapshot': () => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.getSnapshot();
    },
    'workbench:command': (command) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.command(command);
    },
    'app:get-info': () => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
    }),
    'chat:get-status': () => chat.status(),
    'chat:get': ({ conversationId }) => {
      assertLegacySession(conversationId);
      return chat.get(conversationId);
    },
    'chat:send': ({ conversationId, text }) => {
      assertLegacySession(conversationId);
      return chat.send(conversationId, text);
    },
    'chat:cancel': ({ conversationId }) => {
      assertLegacySession(conversationId);
      return chat.cancel(conversationId);
    },
    'chat:reset': ({ conversationId }) => {
      assertLegacySession(conversationId);
      return chat.reset(conversationId);
    },
    'execution:get-status': () => getExecutionStatus(),
  };

  for (const channel of INVOKE_CHANNEL_NAMES) {
    ipcMain.handle(channel, (event, raw: unknown) => {
      assertTrustedSender(senderInfo(event, window), trusted);
      const request = invokeChannels[channel].request.parse(raw);
      const handler = handlers[channel] as (request: unknown) => unknown;
      return Promise.resolve(handler(request)).then((result) => invokeChannels[channel].response.parse(result));
    });
  }
  return () => {
    for (const channel of INVOKE_CHANNEL_NAMES) ipcMain.removeHandler(channel);
  };
}

export function sendToRenderer<C extends EventChannel>(window: BrowserWindow, channel: C, payload: EventPayload<C>): void {
  if (window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}
