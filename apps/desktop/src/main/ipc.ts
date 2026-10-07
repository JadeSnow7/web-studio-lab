import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
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
import type { PreviewController } from './preview/controller';

type Handlers = {
  [C in InvokeChannel]: (request: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

export interface IpcDeps {
  window: BrowserWindow;
  preview: PreviewController;
  trusted: TrustedRenderer;
  chat: ChatService;
}

function senderInfo(event: IpcMainInvokeEvent, window: BrowserWindow) {
  const frame = event.senderFrame;
  return {
    isMainWindow: !window.isDestroyed() && event.sender === window.webContents,
    isTopFrame: frame !== null && frame === event.sender.mainFrame,
    frameUrl: frame?.url ?? null,
  };
}

export function registerIpc({ window, preview, trusted, chat }: IpcDeps): () => void {
  const handlers: Handlers = {
    'resources:list': ({ spaceId }) => chat.resourcesList(spaceId),
    'resources:capture': async ({ spaceId, expectedPage, resourceId }) =>
      chat.resourcesSave(spaceId, await preview.captureResource(expectedPage), resourceId),
    'resources:remove': ({ spaceId, resourceId }) => chat.resourcesRemove(spaceId, resourceId),
    'preview:get-state': () => preview.getState(),
    'preview:set-layout': (layout) => preview.setLayout(layout),
    'preview:freeze': () => preview.freeze(),
    'preview:navigate': ({ url }) => preview.navigate(url),
    'preview:reload': () => preview.reload(),
    'preview:go-back': () => preview.goBack(),
    'preview:go-forward': () => preview.goForward(),
    'preview:focus': () => preview.focus(),
    'preview:start-pick': () => preview.startPick(),
    'preview:cancel-pick': () => preview.cancelPick(),
    'preview:reattach-cdp': () => preview.reattachCdp(),
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
    'chat:get': ({ conversationId }) => chat.get(conversationId),
    'chat:send': ({ conversationId, text }) => chat.send(conversationId, text),
    'chat:cancel': ({ conversationId }) => chat.cancel(conversationId),
    'chat:reset': ({ conversationId }) => chat.reset(conversationId),
    'terminal:get': () => chat.terminalGet(),
    'terminal:open': ({ cols, rows }) => chat.terminalOpen(cols, rows),
    'terminal:write': ({ sessionId, data }) => chat.terminalWrite(sessionId, data),
    'terminal:resize': ({ sessionId, cols, rows }) => chat.terminalResize(sessionId, cols, rows),
    'terminal:close': ({ sessionId }) => chat.terminalClose(sessionId),
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
