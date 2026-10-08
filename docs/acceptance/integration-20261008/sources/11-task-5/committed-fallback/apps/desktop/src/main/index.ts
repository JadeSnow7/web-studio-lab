import path from 'node:path';
import { app, session, type BrowserWindow } from 'electron';
import { ChatService } from './chat-service';
import { registerIpc, sendToRenderer } from './ipc';
import { installAppMenu } from './menu';
import { PreviewController } from './preview/controller';
import { DEMO_HOME_URL, DEMO_ORIGIN, installDemoProtocol, registerDemoScheme } from './preview/demo-protocol';
import { createMainWindow, rendererSource } from './window';

/** 演示页面使用的内存 session 分区，不落盘，与工作台默认 session 隔离。 */
const PREVIEW_PARTITION = 'preview-demo';

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

  const previewSession = session.fromPartition(PREVIEW_PARTITION);
  denyAllPermissions(previewSession);
  installDemoProtocol(previewSession, demoRoot());

  const preview = new PreviewController(window, {
    partition: PREVIEW_PARTITION,
    homeUrl: DEMO_HOME_URL,
    allowedOrigins: [DEMO_ORIGIN],
    onState: (state) => sendToRenderer(window, 'preview:state', state),
    onCaptured: (capture) => sendToRenderer(window, 'preview:captured', capture),
  });
  const chat = new ChatService(
    (conversation) => sendToRenderer(window, 'chat:conversation', conversation),
    (status) => sendToRenderer(window, 'chat:status', status),
    (snapshot) => sendToRenderer(window, 'terminal:state', snapshot),
  );
  const unregisterIpc = registerIpc({ window, preview, trusted, chat });
  installAppMenu(window, preview);
  preview.load();

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
      .then(() => {
        preview.dispose();
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
