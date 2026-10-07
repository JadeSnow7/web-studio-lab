import type { ResourceCollection } from './resources';
import type { PageIdentity } from './preview';
import type { TerminalSnapshot } from './terminal';
import type { ChatConversation, ChatSlot, ChatStatus } from './chat';
import type { AppInfo, ShellCommand } from './app';
import type { ExecutionStatus } from './execution';
import type { PageCapture, PreviewFreezeResult, PreviewLayout, PreviewState } from './preview';

export type Unsubscribe = () => void;

/**
 * preload 通过 contextBridge 暴露给工作台 renderer 的全部能力（window.studio）。
 * 每个方法对应 ipc.ts 中的一个通道；不暴露 ipcRenderer 本身。
 */
export interface StudioApi {
  resources: {
    list(spaceId: string): Promise<ResourceCollection>;
    capture(spaceId: string, expectedPage: PageIdentity, resourceId?: string): Promise<ResourceCollection>;
    remove(spaceId: string, resourceId: string): Promise<ResourceCollection>;
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
  terminal: {
    get(): Promise<TerminalSnapshot>;
    open(cols: number, rows: number): Promise<TerminalSnapshot>;
    write(sessionId: string, data: string): Promise<void>;
    resize(sessionId: string, cols: number, rows: number): Promise<void>;
    close(sessionId: string): Promise<TerminalSnapshot>;
    onState(listener: (state: TerminalSnapshot) => void): Unsubscribe;
  };
  preview: {
    getState(): Promise<PreviewState>;
    setLayout(layout: PreviewLayout): Promise<void>;
    /** 截取当前页面后隐藏原生视图，供浮层遮挡期间显示静态快照。 */
    freeze(): Promise<PreviewFreezeResult>;
    navigate(url: string): Promise<void>;
    reload(): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    focus(): Promise<void>;
    startPick(): Promise<void>;
    cancelPick(): Promise<void>;
    reattachCdp(): Promise<void>;
    onState(listener: (state: PreviewState) => void): Unsubscribe;
    onCaptured(listener: (capture: PageCapture) => void): Unsubscribe;
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
