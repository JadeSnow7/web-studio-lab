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
  workbench: {
    getSnapshot(): Promise<WorkbenchSnapshot>;
    reload(): Promise<WorkbenchSnapshot>;
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
