import type { SetupSnapshot, RuntimeConfig } from './setup';
import type { RunPatchResult } from './source-change';
import type { EnvironmentDescription, WorkbenchObservationInput, WorkspaceObservationResult } from './index';
import type { WorkbenchCommand, WorkbenchEvent, WorkbenchResult, WorkbenchSnapshot } from './workspace';
import type { ChatConversation, ChatSlot, ChatStatus } from './chat';
import type { HarnessProfileId, HarnessProfilesSnapshot, HarnessSelection } from './harness';
import type { AppInfo, ShellCommand } from './app';
import type { ExecutionStatus } from './execution';

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
  shell: {
    onCommand(listener: (command: ShellCommand) => void): Unsubscribe;
  };
}
