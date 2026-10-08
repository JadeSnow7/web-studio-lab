import { WorkbenchApplication } from './workbench/application';
import { FileWorkbenchRepository } from './workbench/repository';
import { WorkbenchHost } from './workbench/host';
import path from 'node:path';
import { app, session, type BrowserWindow } from 'electron';
import { ChatService } from './chat-service';
import { registerIpc, sendToRenderer } from './ipc';
import { installAppMenu } from './menu';
import { registerDemoScheme } from './preview/demo-protocol';
import { createMainWindow, rendererSource } from './window';

registerDemoScheme();

function demoRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'demo', 'taskflow') : path.resolve(app.getAppPath(), '../../demo/taskflow');
}

function denyAllPermissions(target: Electron.Session): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

function openWorkbench(): BrowserWindow {
  const trusted = rendererSource();
  const window = createMainWindow(trusted);

  let workbench: WorkbenchApplication | null = null;
  const chat = new ChatService(
    (conversation) => {
      sendToRenderer(window, 'chat:conversation', conversation);
      workbench?.onConversation(conversation);
    },
    (status) => sendToRenderer(window, 'chat:status', status),
    (snapshot, resourceId, binding) => {
      workbench?.onTerminal(resourceId, snapshot, binding);
    },
    (hint) => workbench?.onFileHint(hint),
  );
  const host = new WorkbenchHost(window, chat, demoRoot());
  workbench = new WorkbenchApplication(new FileWorkbenchRepository(path.join(app.getPath('userData'), 'workbench.json')), host, (event) =>
    sendToRenderer(window, 'workbench:event', event),
  );
  host.application = workbench;
  chat.setObservationReader((scope, tool, args, signal) => workbench!.observeForTurn(scope, tool, args, signal));
  const unregisterIpc = registerIpc({ window, trusted, chat, workbench });
  installAppMenu(window, host);

  // 窗口关闭前释放 Browser 区页面与 IPC 处理器。
  let closing = false;
  let cleaned = false;
  window.on('close', (event) => {
    if (cleaned) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void chat
      .shutdown()
      .then(async () => {
        try {
          await workbench?.getSnapshot();
        } catch (error) {
          console.error('工作台状态不可读；guest清理已确认，继续关闭窗口', error);
        }
        host.dispose();
        unregisterIpc();
        cleaned = true;
        window.close();
      })
      .catch((error: unknown) => {
        console.error('对话服务清理失败', error);
        closing = false;
      });
  });
  return window;
}

app.whenReady().then(() => {
  denyAllPermissions(session.defaultSession);
  openWorkbench();
  app.on('activate', () => {
    // 本版本只有一个工作台窗口：全部关闭后由 window-all-closed 退出应用。
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
