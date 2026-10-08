import { ChatSlotSchema, type ChatConversation, type ChatStatus } from '@wsl/protocol';
import { createStore } from '../lib/store';
import { draftActions, draftsStore, CONVERSATIONS } from './drafts';

export interface ChatState {
  status: ChatStatus | null;
  conversations: Readonly<Record<string, ChatConversation>>;
  errors: Readonly<Record<string, string | null>>;
  pending: Readonly<Record<string, boolean>>;
}
export const chatStore = createStore<ChatState>({ status: null, conversations: {}, errors: {}, pending: {} });

/** 服务序号全局递增：旧初始查询、旧轮次响应与 reset 前事件不会覆盖新快照。 */
export function projectConversation(state: ChatState, snapshot: ChatConversation): ChatState {
  const old = state.conversations[snapshot.conversationId];
  if (old && old.seq >= snapshot.seq) return state;
  return { ...state, conversations: { ...state.conversations, [snapshot.conversationId]: snapshot } };
}
export function receiveConversation(snapshot: ChatConversation) {
  chatStore.set((state) => projectConversation(state, snapshot));
}
export function chatBlockedReason(id: string): string | null {
  const state = chatStore.get();
  if (!state.status?.available) return state.status?.reason ?? '正在检查 Codex CLI…';
  const conversation = state.conversations[id];
  return state.pending[id] || conversation?.state === 'running' || conversation?.state === 'cancelling' ? '正在等待当前回复结束' : null;
}
async function act(id: string, action: () => Promise<ChatConversation>): Promise<boolean> {
  if (chatStore.get().pending[id]) return false;
  chatStore.set((state) => ({ ...state, pending: { ...state.pending, [id]: true }, errors: { ...state.errors, [id]: null } }));
  try {
    receiveConversation(await action());
    return true;
  } catch (error) {
    chatStore.set((state) => ({ ...state, errors: { ...state.errors, [id]: (error as Error).message } }));
    return false;
  } finally {
    chatStore.set((state) => ({ ...state, pending: { ...state.pending, [id]: false } }));
  }
}
export const chatActions = {
  async send(id: string, text: string) {
    if (chatBlockedReason(id)) return false;
    const accepted = await act(id, () => window.studio.chat.send(ChatSlotSchema.parse(id), text));
    if (accepted && draftsStore.get()[id] === text) draftActions.set(id, '');
    return accepted;
  },
  cancel: (id: string) => act(id, () => window.studio.chat.cancel(ChatSlotSchema.parse(id))),
  reset: (id: string) => act(id, () => window.studio.chat.reset(ChatSlotSchema.parse(id))),
};
export async function initializeChat() {
  window.studio.chat.onStatus((status) => chatStore.set((state) => ({ ...state, status })));
  window.studio.chat.onConversation(receiveConversation);
  try {
    const status = await window.studio.chat.getStatus();
    chatStore.set((state) => ({ ...state, status }));
    await Promise.all(
      Object.keys(CONVERSATIONS)
        .filter((id) => CONVERSATIONS[id]?.scope.kind === 'personal')
        .map(async (id) => receiveConversation(await window.studio.chat.get(ChatSlotSchema.parse(id)))),
    );
  } catch (error) {
    chatStore.set((state) => ({
      ...state,
      status: { available: false, reason: (error as Error).message, version: null, sandbox: null, cwd: null },
    }));
  }
}
