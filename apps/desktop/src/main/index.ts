import { ExitCoordinator, shutdownOwners } from './shutdown';
import { packagedTemplateRuntime } from './template-runtime';
import { SetupManager } from './setup';
import { NativeSetupAdapter } from './setup-adapter';
import { WorkbenchApplication } from './workbench/application';
import { FileWorkbenchRepository } from './workbench/repository';
import { AppControl, FileAppControlStore } from './workbench/app-control';
import { WorkbenchHost } from './workbench/host';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, session, type BrowserWindow } from 'electron';
import { ChatService } from './chat-service';
import { DebugStatus, debugStatusEnabled } from './debug-status';
import { getExecutionStatus } from './execution';
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
  // 诊断通道的启用判定只在这里：开发服务器，或 WSL_DEBUG_STATUS=1；未启用时下面所有诊断装配都不存在。
  const debugEnabled = debugStatusEnabled(trusted, process.env);
  const window = createMainWindow(trusted, { debugStatus: debugEnabled });
  let debug: DebugStatus | undefined;
  if (debugEnabled) {
    // 开发环境变量绕过安装记录，其中的授权根与 SSH 身份在这里补充给脱敏。
    const developmentEnv = app.isPackaged ? [] : [process.env['WSL_OBSERVATION_ROOT'], process.env['WSL_SSH_ROOT']];
    const developmentSsh = app.isPackaged ? [] : [process.env['WSL_SSH_HOST'], process.env['WSL_SSH_USER']];
    debug = new DebugStatus({
      homeDir: os.homedir(),
      logPath: process.env['WSL_STATUS_LOG'] ? path.resolve(process.env['WSL_STATUS_LOG']) : null,
      extraRoots: developmentEnv.filter((value): value is string => !!value),
      extraSshIdentities: developmentSsh.filter((value): value is string => !!value),
      emit: (transition) => sendToRenderer(window, 'debug:status', transition),
      emitFactsChanged: () => sendToRenderer(window, 'debug:facts-changed', 'changed'),
      reportError: (message, error) => console.error(message, error),
    });
    // 基线：启动时已知的安装记录与固定的执行状态；对话与工作台快照在各自发布时订阅。
    debug.update({ setup: setup.status(), execution: getExecutionStatus() });
    debug.startLog();
  }

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
      debug?.onChat(status);
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
  workbench = new WorkbenchApplication(new FileWorkbenchRepository(path.join(app.getPath('userData'), 'workbench.json')), host, (event) => {
    debug?.onWorkbench(event.snapshot);
    sendToRenderer(window, 'workbench:event', event);
  });
  host.application = workbench;
  chat.setObservationReader((scope, tool, args, signal) => workbench!.observeForTurn(scope, tool, args, signal));
  chat.setResearchReader((call, signal) => workbench!.researchForTurn(call, signal));
  const control = new AppControl({
    context: (scope) => workbench!.appControlContext(scope),
    ui: (resourceId) => host.appUi(resourceId),
    agent: (target, appInstanceId, operation, signal) => host.appAgent(target, appInstanceId, operation, signal),
    motaControl: (request, signal) => workbench!.motaControlForRun(request, signal),
    motaDocumentChanged: (binding, previous, next) => workbench!.motaDocumentChanged(binding, previous, next),
    logs: (target, maxBytes) => host.appLogs(target, maxBytes),
    leaseValid: (projectId, appInstanceId) => host.appLeaseValid(projectId, appInstanceId),
    restart: (workspaceId, appInstanceId) => workbench!.restartAppForControl(workspaceId, appInstanceId),
    pendingChanged: (workspaceId, runId) => workbench!.onAppCleanupChanged(workspaceId, runId),
    store: new FileAppControlStore(path.join(app.getPath('userData'), 'app-control')),
  });
  workbench.setAppControl(control);
  chat.setAppControlReader((scope, tool, args, signal) => workbench!.appControlForTurn(scope, tool, args, signal));
  const unregisterIpc = registerIpc({ window, trusted, chat, workbench, setup, ...(debug ? { debug } : {}) });
  const unsubscribeSetup = setup.subscribe((snapshot) => {
    debug?.onSetup(snapshot);
    sendToRenderer(window, 'setup:status', snapshot);
  });
  installAppMenu(window, host, { debugStatus: debugEnabled });

  const exit = new ExitCoordinator(
    async () => {
      await shutdownOwners([
        () => setup.shutdown(),
        async () => {
          const errors: unknown[] = [];
          for (const cleanup of [() => workbench?.shutdown(), () => chat.shutdown()]) {
            try {
              await cleanup();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length) throw new AggregateError(errors, '任务和源码证据清理未确认');
        },
      ]);
      // Flush Main's queued cleanup receipts before closing the process.
      try {
        await workbench?.getSnapshot();
      } catch (error) {
        console.error('工作台状态不可读；guest清理已确认，继续关闭窗口', error);
      }
    },
    async (options) => (await dialog.showMessageBox(window, options)).response,
  );
  window.on('show', () => {
    void host.resumeAudio().catch((error: unknown) => console.error('恢复录音监视失败', error));
  });
  window.on('restore', () => {
    void host.resumeAudio().catch((error: unknown) => console.error('恢复录音监视失败', error));
  });
  window.on('hide', () => {
    void host.deactivateAudio().catch((error: unknown) => console.error('隐藏窗口时录音清理失败', error));
  });
  window.on('minimize', () => {
    void host.deactivateAudio().catch((error: unknown) => console.error('最小化时录音清理失败', error));
  });
  let closing = false;
  let allowed = false;
  window.on('close', (event) => {
    if (allowed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void host
      .deactivateAudio()
      .catch((error: unknown) => console.error('退出前音轨核验失败；预览已销毁，继续回收 guest', error))
      .then(() => exit.request())
      .then(async (shouldClose) => {
        if (!shouldClose) {
          await host.resumeAudio();
          return;
        }
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
