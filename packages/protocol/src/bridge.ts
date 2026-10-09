import type { SetupSnapshot, RuntimeConfig } from './setup';
import type { EnvironmentDescription, WorkbenchObservationInput, WorkspaceObservationResult } from './index';
import type { WorkbenchCommand, WorkbenchEvent, WorkbenchResult, WorkbenchSnapshot } from './workspace';
import type { ChatConversation, ChatSlot, ChatStatus } from './chat';
import type { AppInfo, ShellCommand } from './app';
import type { ExecutionStatus } from './execution';

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
    command(command: WorkbenchCommand): Promise<WorkbenchResult>;
    onEvent(listener: (event: WorkbenchEvent) => void): Unsubscribe;
  };
  chat: {
    getStatus(): Promise<ChatStatus>;
    get(conversationId: ChatSlot): Promise<ChatConversation>;
    send(conversationId: ChatSlot, text: string): Promise<ChatConversation>;
    cancel(conversationId: ChatSlot): Promise<ChatConversation>;
    reset(conversationId: ChatSlot): Promise<ChatConversation>;
    onStatus(listener: (status: ChatStatus) => void): Unsubscribe;
    onConversation(listener: (conversation: ChatConversation) => void): Unsubscribe;
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
