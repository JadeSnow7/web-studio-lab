import { ExitCoordinator, shutdownOwners } from './shutdown';
import { packagedTemplateRuntime } from './template-runtime';
import { SetupManager } from './setup';
import { NativeSetupAdapter } from './setup-adapter';
import { WorkbenchApplication } from './workbench/application';
import { FileWorkbenchRepository } from './workbench/repository';
import { AppControl, FileAppControlStore } from './workbench/app-control';
import { WorkbenchHost } from './workbench/host';
import path from 'node:path';
import { app, dialog, session, type BrowserWindow } from 'electron';
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

function openWorkbench(setup: SetupManager): BrowserWindow {
  const trusted = rendererSource();
  const window = createMainWindow(trusted);

  let templateDependencies;
  if (app.isPackaged) {
    try {
      templateDependencies = packagedTemplateRuntime(process.resourcesPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '标准模板载荷校验失败';
      console.error('Installed template rejected:', message);
      setup.blockInstalledPayload(message);
    }
  }
  let workbench: WorkbenchApplication | null = null;
  const chat = new ChatService(
    (conversation) => {
      sendToRenderer(window, 'chat:conversation', conversation);
      workbench?.onConversation(conversation);
    },
    (status) => {
      sendToRenderer(window, 'chat:status', status);
      void workbench?.onChatStatus().catch((error: unknown) => console.error('工作台执行环境状态更新失败', error));
    },
    (snapshot, resourceId, binding) => {
      workbench?.onTerminal(resourceId, snapshot, binding);
    },
    (hint) => workbench?.onFileHint(hint),
    !app.isPackaged && ['WSL_SBX_NAME', 'WSL_SBX_BIN', 'WSL_OBSERVATION_ROOT', 'WSL_SSH_HOST'].some((key) => process.env[key])
      ? undefined
      : {
          ...setup.runtimeConfig(),
          sshAgent: process.env['SSH_AUTH_SOCK'] ?? null,
          ...(templateDependencies ? { templateDependencies } : {}),
        },
  );
  const host = new WorkbenchHost(window, chat, demoRoot());
  workbench = new WorkbenchApplication(new FileWorkbenchRepository(path.join(app.getPath('userData'), 'workbench.json')), host, (event) =>
    sendToRenderer(window, 'workbench:event', event),
  );
  host.application = workbench;
  chat.setObservationReader((scope, tool, args, signal) => workbench!.observeForTurn(scope, tool, args, signal));
  const control = new AppControl({
    context: (scope) => workbench!.appControlContext(scope),
    ui: (resourceId) => host.appUi(resourceId),
    agent: (target, appInstanceId, operation, signal) => host.appAgent(target, appInstanceId, operation, signal),
    logs: (target, maxBytes) => host.appLogs(target, maxBytes),
    leaseValid: (projectId, appInstanceId) => host.appLeaseValid(projectId, appInstanceId),
    restart: (workspaceId, appInstanceId) => workbench!.restartAppForControl(workspaceId, appInstanceId),
    pendingChanged: (workspaceId, runId) => workbench!.onAppCleanupChanged(workspaceId, runId),
    store: new FileAppControlStore(path.join(app.getPath('userData'), 'app-control')),
  });
  workbench.setAppControl(control);
  chat.setAppControlReader((scope, tool, args, signal) => workbench!.appControlForTurn(scope, tool, args, signal));
  const unregisterIpc = registerIpc({ window, trusted, chat, workbench, setup });
  const unsubscribeSetup = setup.subscribe((snapshot) => sendToRenderer(window, 'setup:status', snapshot));
  installAppMenu(window, host);

  const exit = new ExitCoordinator(
    async () => {
      await shutdownOwners([() => setup.shutdown(), () => chat.shutdown()]);
      // Flush Main's queued cleanup receipts before closing the process.
      try {
        await workbench?.getSnapshot();
      } catch (error) {
        console.error('工作台状态不可读；guest清理已确认，继续关闭窗口', error);
      }
    },
    async (options) => (await dialog.showMessageBox(window, options)).response,
  );
  let closing = false;
  let allowed = false;
  window.on('close', (event) => {
    if (allowed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void exit
      .request()
      .then((shouldClose) => {
        if (!shouldClose) return;
        host.dispose();
        unregisterIpc();
        unsubscribeSetup();
        allowed = true;
        window.close();
      })
      .catch((error: unknown) => console.error('退出对话框失败', error))
      .finally(() => {
        closing = false;
      });
  });
  return window;
}

app.whenReady().then(async () => {
  denyAllPermissions(session.defaultSession);
  const resourceRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.resolve(app.getAppPath(), '../../packaging/generated/runtime');
  const setup = await SetupManager.open(
    path.join(app.getPath('userData'), 'runtime.json'),
    path.join(resourceRoot, 'python/bin/python3'),
    new NativeSetupAdapter(
      resourceRoot,
      app.isPackaged ? path.resolve(path.dirname(process.execPath), '../..') : app.getAppPath(),
      app.getPath('userData'),
    ),
  );
  openWorkbench(setup);
  app.on('activate', () => {
    // 本版本只有一个工作台窗口：全部关闭后由 window-all-closed 退出应用。
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
