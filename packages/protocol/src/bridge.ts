import type { SetupSnapshot, RuntimeConfig } from './setup';
import type { RunPatchResult } from './source-change';
import type { EnvironmentDescription, WorkbenchObservationInput, WorkspaceObservationResult } from './index';
import type { WorkbenchCommand, WorkbenchEvent, WorkbenchResult, WorkbenchSnapshot } from './workspace';
import type { ChatConversation, ChatSlot, ChatStatus } from './chat';
import type { HarnessProfileId, HarnessProfilesSnapshot, HarnessSelection } from './harness';
import type { AppInfo, ShellCommandEvent, NativeBrowserFocus } from './app';
import type { ExecutionStatus } from './execution';
import type { NativeMenuChoice, NativeMenuContext, NativeMenuId } from './native-menu';
import type {
  WorkflowAccepted,
  WorkflowCommandCard,
  WorkflowCommandSave,
  WorkflowPatchResult,
  WorkflowRunRow,
  WorkflowStatusProjection,
  WorkflowUpdateEvent,
} from './workflow';

import type { CatalogAction, ResourceRevision, CatalogReferenceSnapshot } from './resource-catalog';
export type Unsubscribe = () => void;

/**
 * preload 通过 contextBridge 暴露给工作台 renderer 的全部能力（window.studio）。
 * 每个方法对应 ipc.ts 中的一个通道；不暴露 ipcRenderer 本身。
 */
export interface StudioApi {
  setup: {
    status(): Promise<SetupSnapshot>;
    check(): Promise<SetupSnapshot>;
    prepare(): Promise<SetupSnapshot>;
    retry(): Promise<SetupSnapshot>;
    cancel(): Promise<SetupSnapshot>;
    login(provider: 'docker' | 'openai', acknowledgeGlobalCredentials: boolean): Promise<SetupSnapshot>;
    save(settings: Pick<RuntimeConfig, 'localRoot' | 'ssh'>): Promise<SetupSnapshot>;
    chooseRoot(): Promise<string | null>;
    onStatus(listener: (snapshot: SetupSnapshot) => void): Unsubscribe;
  };
  workbench: {
    getSnapshot(): Promise<WorkbenchSnapshot>;
    reload(): Promise<WorkbenchSnapshot>;
    environments(): Promise<EnvironmentDescription[]>;
    observe(input: WorkbenchObservationInput): Promise<WorkspaceObservationResult>;
    catalogCommand(command: CatalogAction): Promise<WorkbenchResult>;
    resourceRevision(resourceId: string, version: number): Promise<ResourceRevision>;
    runReferences(workspaceId: string, runId: string): Promise<CatalogReferenceSnapshot | null>;
    runPatch(workspaceId: string, runId: string): Promise<RunPatchResult>;
    command(command: WorkbenchCommand): Promise<WorkbenchResult>;
    onEvent(listener: (event: WorkbenchEvent) => void): Unsubscribe;
  };
  chat: {
    getStatus(): Promise<ChatStatus>;
    get(conversationId: ChatSlot): Promise<ChatConversation>;
    send(conversationId: ChatSlot, text: string, references?: { resourceId: string; version: number }[]): Promise<ChatConversation>;
    cancel(conversationId: ChatSlot): Promise<ChatConversation>;
    reset(conversationId: ChatSlot): Promise<ChatConversation>;
    /** 回复个人对话中的权限请求（W4b）；optionId 为 null 表示拒绝。空间会话走工作台命令 answerPermission。 */
    answerPermission(conversationId: ChatSlot, requestId: string, optionId: string | null): Promise<ChatConversation>;
    onStatus(listener: (status: ChatStatus) => void): Unsubscribe;
    onConversation(listener: (conversation: ChatConversation) => void): Unsubscribe;
    /** Harness Profile（W4）：只含配置目录引用与自检结果，不含凭据。 */
    profiles: {
      get(): Promise<HarnessProfilesSnapshot>;
      create(label: string): Promise<HarnessProfilesSnapshot>;
      check(profileId: HarnessProfileId): Promise<HarnessProfilesSnapshot>;
      remove(profileId: HarnessProfileId): Promise<HarnessProfilesSnapshot>;
      setDefault(selection: HarnessSelection): Promise<HarnessProfilesSnapshot>;
      onChange(listener: (snapshot: HarnessProfilesSnapshot) => void): Unsubscribe;
    };
  };
  app: {
    getInfo(): Promise<AppInfo>;
  };
  execution: {
    getStatus(): Promise<ExecutionStatus>;
  };
  /**
   * W5 workflow 命令入口（最小可信产品面）：命令卡展示脚本/args/输入与 hash；
   * builtin 代码即批准，saved 命令保存即失效、须显式批准后才可运行；
   * run/resume 由 Main 幂等受理（requestId 去重），并发 1，busy 以明确错误拒绝。
   * stop 返回时清理已确认。
   */
  workflow: {
    commands(): Promise<WorkflowCommandCard[]>;
    run(requestId: string, commandId: string): Promise<WorkflowAccepted>;
    resume(requestId: string, parentRunId: string, commandId: string): Promise<WorkflowAccepted>;
    saveCommand(input: WorkflowCommandSave): Promise<WorkflowCommandCard>;
    approveCommand(commandId: string): Promise<WorkflowCommandCard>;
    deleteCommand(commandId: string): Promise<null>;
    stop(runId: string): Promise<WorkflowRunRow>;
    reconcile(runId: string): Promise<WorkflowRunRow>;
    status(runId: string): Promise<WorkflowStatusProjection | null>;
    runs(): Promise<WorkflowRunRow[]>;
    /** W6b：候选最新发布的统一 diff 预览（不应用任何修改）。 */
    patch(runId: string): Promise<WorkflowPatchResult>;
    /** W6b：显式把已发布候选应用到受管 App；冲突/忙/不可用均抛明确错误，应用成功后返回更新后的 run 行。 */
    apply(runId: string): Promise<WorkflowRunRow>;
    onUpdate(listener: (update: WorkflowUpdateEvent) => void): Unsubscribe;
  };
  shell: {
    onCommand(listener: (command: ShellCommandEvent) => void): Unsubscribe;
    /**
     * 弹出 Main 原生菜单（OPS-1 S5）。只提交菜单类型与身份上下文；菜单内容由 Main 按快照构建。
     * 返回所选菜单项与 Main 冻结的目标，取消（Esc、点击外部）为 null；非法或过时的上下文被拒绝。
     */
    showMenu<M extends NativeMenuId>(menuId: M, context: NativeMenuContext<M>): Promise<NativeMenuChoice | null>;
    /**
     * 请 Main 把键盘焦点交回工作台页面（OPS-1 R9）：采集完成并展开接收会话后调用，随后 renderer 再聚焦会话输入框。
     * 窗口不在前台时不抢焦点，返回 false。
     */
    focusWorkbench(): Promise<boolean>;
    nativeFocus(): Promise<NativeBrowserFocus | null>;
    restoreBrowserFocus(focus: NativeBrowserFocus): Promise<boolean>;
  };
}
