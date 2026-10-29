import type { AppService } from '../app-service';
import type { CodexChat } from '../codex-chat';
import type { RouteTable, ServiceRequestOf } from './types';

export type ChatMethod = 'register' | 'status' | 'profile.check' | 'permission.reply' | 'get' | 'send' | 'cancel' | 'reset';

type Admission = { cancelled: boolean };

// Capture and resource writes share ordering. Cancellation must bypass a held
// capture so it can revoke CodexChat.preparing before any guest is launched.
export class ChatSendQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Set<Admission>>();
  private readonly admissions = new WeakMap<ServiceRequestOf<'send'>, Admission>();

  /** 收到 send 时同步登记准入，按到达顺序执行；执行并回复后撤销登记。 */
  enqueue(request: ServiceRequestOf<'send'>, execute: () => Promise<void>): void {
    const { conversationId } = request.payload;
    const admission = { cancelled: false };
    const pending = this.pending.get(conversationId) ?? new Set();
    pending.add(admission);
    this.pending.set(conversationId, pending);
    this.admissions.set(request, admission);
    this.tail = this.tail.then(async () => {
      try {
        await execute();
      } finally {
        const current = this.pending.get(conversationId);
        current?.delete(admission);
        if (!current?.size) this.pending.delete(conversationId);
      }
    });
  }

  /** cancel/reset 一到达就撤销该对话仍在排队的 send。 */
  revoke(conversationId: string): void {
    for (const admission of this.pending.get(conversationId) ?? []) admission.cancelled = true;
  }

  hasPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  cancelled(request: ServiceRequestOf<'send'>): boolean {
    return this.admissions.get(request)?.cancelled ?? false;
  }
}

export type ChatRouteOwners = {
  chat: CodexChat;
  apps: Pick<AppService, 'assertTaskAdmission'>;
  ready: Promise<unknown>;
  sends: ChatSendQueue;
};

export function createChatRoutes({ chat, apps, ready, sends }: ChatRouteOwners): RouteTable<ChatMethod> {
  return {
    register: ({ payload }) => {
      chat.register(payload.conversationId, payload.workspaceId);
      return null;
    },
    status: () => chat.getStatus(),
    'profile.check': ({ payload }) => chat.checkProfileReceipt(payload.harnessId, payload.profileDir),
    'permission.reply': ({ payload }) => chat.answerPermission(payload.conversationId, payload.requestId, payload.optionId),
    get: ({ payload }) => chat.get(payload.conversationId),
    send: async (request) => {
      const { payload } = request;
      await ready;
      await apps.assertTaskAdmission(payload.references.workspaceId);
      return sends.cancelled(request)
        ? chat.get(payload.conversationId)
        : chat.send(payload.conversationId, payload.text, payload.observationScope, payload.references, payload.harness);
    },
    cancel: ({ payload }) => chat.cancel(payload.conversationId, sends.hasPending(payload.conversationId)),
    reset: ({ payload }) => chat.reset(payload.conversationId),
  };
}
