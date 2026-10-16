import type { SetupManager } from './setup';
import type { WorkbenchApplication } from './workbench/application';
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  invokeChannels,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
} from '@wsl/protocol';
import type { ChatService } from './chat-service';
import { getExecutionStatus } from './execution';
import type { DebugStatus } from './debug-status';
import { activeInvokeChannels, assertChannelEnabled, assertTrustedSender, type TrustedRenderer } from './ipc-guard';

type Handlers = {
  [C in InvokeChannel]: (request: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

export interface IpcDeps {
  window: BrowserWindow;
  trusted: TrustedRenderer;
  chat: ChatService;
  workbench?: WorkbenchApplication;
  setup?: SetupManager;
  /** 仅诊断通道启用时存在；同时决定是否注册 `debug:status`。 */
  debug?: DebugStatus;
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

export function registerIpc({ window, trusted, chat, workbench, setup, debug }: IpcDeps): () => void {
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
    // 诊断通道只读订阅已发布的快照：把返回给 renderer 的同一份快照交给 debug，不改业务状态。
    'workbench:reload': async () => {
      if (!workbench) throw new Error('工作台服务不可用');
      const snapshot = await workbench.retryInitialization();
      debug?.onWorkbench(snapshot);
      return snapshot;
    },
    'workbench:get-snapshot': async () => {
      if (!workbench) throw new Error('工作台服务不可用');
      const snapshot = await workbench.getSnapshot();
      debug?.onWorkbench(snapshot);
      return snapshot;
    },
    'workbench:command': (command) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.command(command);
    },
    'workbench:catalog-command': (command) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.catalogCommand(command);
    },
    'workbench:resource-revision': ({ resourceId, version }) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.catalogRevision(resourceId, version);
    },
    'workbench:run-patch': ({ workspaceId, runId }) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.runPatch(workspaceId, runId);
    },
    'workbench:run-references': ({ workspaceId, runId }) => {
      if (!workbench) throw new Error('工作台服务不可用');
      return workbench.runReferences(workspaceId, runId);
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
    'chat:get-status': async () => {
      const status = await chat.status();
      debug?.onChat(status);
      return status;
    },
    'chat:get': ({ conversationId }) => {
      assertLegacySession(conversationId);
      return chat.get(conversationId);
    },
    'chat:send': async ({ conversationId, text, references }) => {
      assertLegacySession(conversationId);
      if (!workbench) throw new Error('工作台服务不可用');
      return chat.send(conversationId, text, undefined, await workbench.personalReferences(references ?? []));
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
    'debug:status': () => {
      if (!debug) throw new Error('诊断通道未启用');
      return debug.snapshot();
    },
  };

  const channels = activeInvokeChannels(debug !== undefined);
  for (const channel of channels) {
    ipcMain.handle(channel, (event, raw: unknown) => {
      assertTrustedSender(senderInfo(event, window), trusted);
      assertChannelEnabled(channel, debug !== undefined);
      const request = invokeChannels[channel].request.parse(raw);
      const handler = handlers[channel] as (request: unknown) => unknown;
      return Promise.resolve(handler(request)).then((result) => invokeChannels[channel].response.parse(result));
    });
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

export function sendToRenderer<C extends EventChannel>(window: BrowserWindow, channel: C, payload: EventPayload<C>): void {
  if (window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}
