import type { NativeBrowserFocus } from '@wsl/protocol';
import type { SetupManager } from './setup';
import type { WorkbenchApplication } from './workbench/application';
import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  invokeChannels,
  type AppTarget,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
} from '@wsl/protocol';
import type { ChatService } from './chat-service';
import type { HarnessProfileService } from './harness-profiles';
import { getExecutionStatus } from './execution';
import type { DebugStatus } from './debug-status';
import type { NativeMenuService } from './native-menu';
import { activeInvokeChannels, assertChannelEnabled, assertTrustedSender, type TrustedRenderer } from './ipc-guard';
import { WorkflowApplicationError, type WorkflowApplication } from './workflow/application';
import { WorkflowCommandError, type WorkflowCommands } from './workflow/commands';
import type { WorkflowCandidateState, WorkflowRunRow } from './workflow/journal-sqlite';

type Handlers = {
  [C in InvokeChannel]: (request: InvokeRequest<C>) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

export interface IpcDeps {
  window: BrowserWindow;
  trusted: TrustedRenderer;
  chat: ChatService;
  /** Harness Profile（W4a）；测试与早期启动阶段可不提供，此时相关通道报错。 */
  profiles?: HarnessProfileService;
  workbench?: WorkbenchApplication;
  setup?: SetupManager;
  /** 仅诊断通道启用时存在；同时决定是否注册 `debug:status`。 */
  debug?: DebugStatus;
  /** 原生菜单（OPS-1 S5）；测试与早期启动阶段可不提供，此时 `shell:show-menu` 报错。 */
  menus?: NativeMenuService;
  browserFocus?: {
    nativeFocus(): NativeBrowserFocus | null;
    restoreBrowserFocus(focus: NativeBrowserFocus): Promise<boolean>;
  };
  /** W4 workflow 应用用例；测试与早期启动阶段可不提供，此时 workflow:* 通道报错。 */
  workflow?: WorkflowApplication;
  /** W5 workflow 命令仓储（内置 + 已保存命令与批准绑定）；缺省时 workflow:* 通道报错。 */
  workflowCommands?: WorkflowCommands;
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

/** runs 行对外投影：剥掉 resultJson/engine/createdSeq/dslVersion/baseTree 等内部列；W6a 透出候选投影；W6b 透出 App 绑定。 */
function workflowRunRowView(row: WorkflowRunRow & { candidate?: WorkflowCandidateState }) {
  return {
    runId: row.runId,
    requestId: row.requestId,
    status: row.status,
    scriptHash: row.scriptHash,
    argsHash: row.argsHash,
    parentRunId: row.parentRunId,
    createdMs: row.createdMs,
    failureCode: row.failureCode,
    ...(row.candidate !== undefined ? { candidate: row.candidate } : {}),
    requiresApp: row.requiresApp,
    writes: row.writes,
    appTarget: row.appTargetJson === null ? null : (JSON.parse(row.appTargetJson) as AppTarget),
  };
}

/** 应用层与命令仓储错误带稳定 code 前缀，renderer 可据此前缀区分 busy/mismatch/not_approved 等。 */
function workflowCall<T>(fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve()
    .then(fn)
    .catch((error: unknown) => {
      if (error instanceof WorkflowApplicationError || error instanceof WorkflowCommandError) {
        throw new Error(`${error.code}：${error.message}`);
      }
      throw error;
    });
}

export function registerIpc({
  window,
  trusted,
  chat,
  profiles,
  workbench,
  setup,
  debug,
  menus,
  browserFocus,
  workflow,
  workflowCommands,
}: IpcDeps): () => void {
  const requireProfiles = () => {
    if (!profiles) throw new Error('Harness Profile 服务不可用');
    return profiles;
  };
  const requireSetup = () => {
    if (!setup) throw new Error('安装服务不可用');
    return setup;
  };
  const requireWorkflow = () => {
    if (!workflow) throw new Error('工作流服务不可用');
    return workflow;
  };
  const requireWorkflowCommands = () => {
    if (!workflowCommands) throw new Error('工作流命令仓储不可用');
    return workflowCommands;
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
      // 与诊断通道同一判定：`debug` 只在开发服务器或 WSL_DEBUG_STATUS=1 时由装配处提供（index.ts）。
      diagnostics: debug !== undefined,
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
      // 个人对话使用全局默认的 Harness 与 Profile（W4-7）。
      const { turn } = requireProfiles().resolve(null);
      await requireProfiles().prepare(turn);
      return chat.send(conversationId, text, undefined, await workbench.personalReferences(references ?? []), turn);
    },
    'chat:permission-reply': ({ conversationId, requestId, optionId }) => {
      assertLegacySession(conversationId);
      return chat.answerPermission(conversationId, requestId, optionId);
    },
    'chat:profiles-get': () => requireProfiles().store.get(),
    'chat:profiles-create': async ({ label }) => {
      const snapshot = await requireProfiles().store.create(label);
      const created = snapshot.profiles.at(-1);
      // 新 Profile 立即自检一次：helper 建好配置目录，结果为未登录，用户随后在终端里登录。
      if (created)
        void requireProfiles()
          .check(created.profileId)
          .catch((error: unknown) => console.error('Profile 自检失败', error));
      return snapshot;
    },
    'chat:profiles-check': ({ profileId }) => requireProfiles().check(profileId),
    'chat:profiles-remove': ({ profileId }) => requireProfiles().store.remove(profileId),
    'chat:profiles-default': (selection) => requireProfiles().store.setDefault(selection),
    'chat:cancel': ({ conversationId }) => {
      assertLegacySession(conversationId);
      return chat.cancel(conversationId);
    },
    'chat:reset': ({ conversationId }) => {
      assertLegacySession(conversationId);
      return chat.reset(conversationId);
    },
    'execution:get-status': () => getExecutionStatus(),
    // 来源已在下方统一核对、输入已按 ShowMenuRequestSchema 解析；身份与所属空间由菜单服务按 Main 快照核对。
    'shell:show-menu': (request) => {
      if (!menus) throw new Error('原生菜单服务不可用');
      return menus.show(request);
    },
    // R9：只把焦点交回本窗口的工作台页面；窗口不在前台（用户已切到其他应用）或已销毁时不抢焦点。
    'shell:focus-workbench': () => {
      if (window.isDestroyed() || !window.isFocused()) return false;
      window.webContents.focus();
      return true;
    },
    'shell:native-focus': () => {
      if (!browserFocus) throw new Error('原生焦点服务不可用');
      return browserFocus.nativeFocus();
    },
    'shell:restore-browser-focus': (focus) => {
      if (!browserFocus) throw new Error('原生焦点服务不可用');
      return browserFocus.restoreBrowserFocus(focus);
    },
    'debug:status': () => {
      if (!debug) throw new Error('诊断通道未启用');
      return debug.snapshot();
    },
    'workflow:commands': () => requireWorkflowCommands().cards(),
    'workflow:run': ({ requestId, commandId }) =>
      workflowCall(async () => {
        const app = requireWorkflow();
        // saved 命令未批准/已变更 → command_not_approved；未知 id → unknown_command。
        const command = await requireWorkflowCommands().resolve(commandId, { requireApproved: true });
        return app.run({ requestId, script: command.script, args: command.args, deadlineMs: command.deadlineMs, input: command.input });
      }),
    'workflow:resume': ({ requestId, parentRunId, commandId }) =>
      workflowCall(async () => {
        const app = requireWorkflow();
        // 续跑绑定父 run 的 hash，与命令当前批准状态无关——命令后续改动不影响续跑。
        const command = await requireWorkflowCommands().resolve(commandId, { requireApproved: false });
        return app.resume({
          requestId,
          parentWorkflowRunId: parentRunId,
          script: command.script,
          args: command.args,
          deadlineMs: command.deadlineMs,
          input: command.input,
        });
      }),
    'workflow:command-save': (request) => workflowCall(() => requireWorkflowCommands().save(request)),
    'workflow:command-approve': ({ commandId }) => workflowCall(() => requireWorkflowCommands().approve(commandId)),
    'workflow:command-delete': ({ commandId }) =>
      workflowCall(async () => {
        await requireWorkflowCommands().delete(commandId);
        return null;
      }),
    'workflow:stop': ({ runId }) =>
      workflowCall(async () => {
        const app = requireWorkflow();
        // 返回时内核清理已确认（attempt 取消、worker dispose、终态 journal 已提交）。
        await app.stop(runId);
        return workflowRunRowView(app.runRow(runId));
      }),
    'workflow:reconcile': ({ runId }) =>
      workflowCall(() => {
        const app = requireWorkflow();
        app.reconcileAsStopped(runId);
        return workflowRunRowView(app.runRow(runId));
      }),
    'workflow:status': ({ runId }) =>
      workflowCall(() => {
        const app = requireWorkflow();
        try {
          return app.status(runId);
        } catch (error) {
          if (error instanceof WorkflowApplicationError && error.code === 'run_not_found') return null;
          throw error;
        }
      }),
    'workflow:runs': () => {
      const app = requireWorkflow();
      return app.listRuns(50).map(workflowRunRowView);
    },
    // W6b：候选 diff 预览——只读，不产生任何写入。
    'workflow:patch': ({ runId }) =>
      workflowCall(async () => {
        const app = requireWorkflow();
        return app.workflowPatch(runId);
      }),
    // W6b：显式授权应用候选——错误码：run_not_found/candidate_unavailable/
    // app_unavailable/project_busy/apply_conflict/apply_failed。
    'workflow:apply': ({ runId }) =>
      workflowCall(async () => {
        const app = requireWorkflow();
        return workflowRunRowView(await app.applyCandidate(runId));
      }),
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
