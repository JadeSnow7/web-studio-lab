import { ExitCoordinator, shutdownOwners } from './shutdown';
import { packagedTemplateRuntime } from './template-runtime';
import { SetupManager } from './setup';
import { NativeSetupAdapter } from './setup-adapter';
import { WorkbenchApplication } from './workbench/application';
import { SqliteWorkflowJournal } from './workflow/journal-sqlite';
import { WorkflowApplication } from './workflow/application';
import { WorkflowCommands } from './workflow/commands';
import { WorkflowCommandsStore } from './workflow/commands-store';
import { ServiceWorkflowEnginePort } from './workflow/service-engine-port';
import { FileWorkbenchRepository } from './workbench/repository';
import { RunSourceRepository } from './workbench/run-source-repository';
import { AppControl, FileAppControlStore } from './workbench/app-control';
import { WorkbenchHost } from './workbench/host';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, session, type BrowserWindow } from 'electron';
import { ChatService } from './chat-service';
import { HarnessProfileService, HarnessProfileStore } from './harness-profiles';
import { DebugStatus, debugStatusEnabled } from './debug-status';
import { getExecutionStatus } from './execution';
import { registerIpc, sendToRenderer } from './ipc';
import { installAppMenu, nativeMenuHost } from './menu';
import { NativeMenuService } from './native-menu';
import { builtinProfileId, profileDirOf, type RouteScopeMember } from '@wsl/protocol';
import { registerDemoScheme } from './preview/demo-protocol';
import { createMainWindow, rendererSource } from './window';

registerDemoScheme();

/**
 * W7：可进 workflow 路由的 Harness——如实写死当前矩阵：只有 codex native 提供
 * argvForIsolation 的隔离执行能力；claude-code 是 ACP spec-harness，进不了成员表
 * （对它声明 harness/profile 的调用由内核/路由池以 unsupported_option 拒绝）。
 */
const WORKFLOW_CAPABLE_HARNESSES: readonly string[] = ['codex'];

function demoRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'demo', 'taskflow') : path.resolve(app.getAppPath(), '../../demo/taskflow');
}

function denyAllPermissions(target: Electron.Session): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

function openWorkbench(setup: SetupManager, profileStore: HarnessProfileStore): BrowserWindow {
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
  let profiles: HarnessProfileService | null = null;
  const chat = new ChatService(
    (conversation) => {
      sendToRenderer(window, 'chat:conversation', conversation);
      workbench?.onConversation(conversation);
    },
    (status) => {
      debug?.onChat(status);
      sendToRenderer(window, 'chat:status', status);
      profiles?.onStatus(status);
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
  profiles = new HarnessProfileService(profileStore, chat);
  profileStore.onChange((snapshot) => sendToRenderer(window, 'chat:profiles', snapshot));
  // host 先于 workflowApp：W6b 的 lane 绑定/候选应用需要它的 App 源码端口。
  const host = new WorkbenchHost(window, chat, demoRoot(), profiles);
  // W4 workflow：journal 在 Main SQLite（userData/workflow/journal.sqlite），引擎是 service 远端实现；
  // 启动先把遗留非终态 run 标记 needs_reconciliation（恢复标记，不写合成事件），由用户核对后标记已停止再续跑。
  // W6a：候选 Git 对象仓在 userData/workflow/runs（Lab 管理，独立于 workbench runs）；
  // 先建 port 再建应用，装配完成后把候选发布委托回填给 port。
  mkdirSync(path.join(app.getPath('userData'), 'workflow'), { recursive: true });
  let workflowUpdateSeq = 0;
  const workflowEnginePort = new ServiceWorkflowEnginePort(chat);
  const workflowApp = new WorkflowApplication({
    journal: new SqliteWorkflowJournal(path.join(app.getPath('userData'), 'workflow', 'journal.sqlite')),
    engine: workflowEnginePort,
    candidateStore: new RunSourceRepository(path.join(app.getPath('userData'), 'workflow', 'runs')),
    // W6b：受管 App 绑定/应用端口——workbench 在后面才装配，按惰性闭包调用时求值。
    appResolver: () => workbench?.managedAppTarget() ?? null,
    appSource: {
      snapshot: (target, signal) => host.appSourceSnapshot(target, signal),
      apply: (target, files, signal) => host.appSourceApply(target, files, signal),
    },
    acquireWriter: (projectId, ownerId) => workbench?.acquireProjectWriter(projectId, ownerId) ?? null,
    // null 是「无阻塞」的健康回执，不能落入 ??——只有 workbench 缺席才报未就绪。
    appBusy: (target) => (workbench === null ? 'unavailable: 工作台未就绪' : workbench.projectWriteBlocker(target)),
    // W7：路由范围从 Profile 快照取——只收录可进 workflow 的 Harness（当前仅 codex native；
    // claude-code 是 ACP spec-harness，无 argvForIsolation 不能进成员表）。logged_out 仍入列：
    // 额度/登录只在执行期诚实失败，受理不预选。快照不可读时回退内置 codex:default，不阻断受理。
    routeScopeProvider: (): RouteScopeMember[] => {
      try {
        return profileStore
          .get()
          .profiles.filter((profile) => WORKFLOW_CAPABLE_HARNESSES.includes(profile.harnessId))
          .map((profile) => ({
            harnessId: profile.harnessId,
            profileId: profile.profileId,
            profileDir: profileDirOf(profile.harnessId, profile.profileId),
          }));
      } catch {
        return [{ harnessId: 'codex', profileId: builtinProfileId('codex'), profileDir: null }];
      }
    },
    onEvent: (runId) => sendToRenderer(window, 'workflow:update', { workflowRunId: runId, seq: ++workflowUpdateSeq }),
  });
  workflowEnginePort.setCandidatePublisher(workflowApp);
  workflowEnginePort.setLaneWorkspaceProvider(workflowApp);
  workflowApp.recoverOpenRuns();
  // W5 命令仓储：saved 命令存 userData/workflow/commands.json；损坏文件 fail-closed（builtin 可用）。
  const workflowCommands = new WorkflowCommands(new WorkflowCommandsStore(path.join(app.getPath('userData'), 'workflow', 'commands.json')));
  void workflowCommands.ready.then(() => {
    if (workflowCommands.storeError)
      console.error('工作流命令仓储读取失败（已保存命令不可用，内置命令不受影响）', workflowCommands.storeError);
  });
  workbench = new WorkbenchApplication(new FileWorkbenchRepository(path.join(app.getPath('userData'), 'workbench.json')), host, (event) => {
    debug?.onWorkbench(event.snapshot);
    sendToRenderer(window, 'workbench:event', event);
  });
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
  const menuSource = workbench;
  const menus = new NativeMenuService({ host: nativeMenuHost(window), snapshot: () => menuSource.currentSnapshot() });
  const unregisterIpc = registerIpc({
    window,
    trusted,
    chat,
    profiles,
    workbench,
    setup,
    menus,
    browserFocus: host,
    workflow: workflowApp,
    workflowCommands,
    ...(debug ? { debug } : {}),
  });
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
          // Keep the service and journal listeners alive until workflow receipts settle.
          await workflowApp.shutdown();
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
  let closing = false;
  let allowed = false;
  window.on('close', (event) => {
    if (allowed) return;
    event.preventDefault();
    workflowApp.beginShutdown();
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
  const profileStore = new HarnessProfileStore(path.join(app.getPath('userData'), 'harness-profiles.json'));
  // 读取失败（内容无效或版本较新）时保留原文件；之后解析选择与设置页都会明确报告该错误。
  await profileStore.load().catch((error: unknown) => console.error('Harness Profile 读取失败', error));
  openWorkbench(setup, profileStore);
  app.on('activate', () => {
    // 本版本只有一个工作台窗口：全部关闭后由 window-all-closed 退出应用。
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
