import { createStore } from '../lib/store';
type Scope = { kind: 'personal' };

/** 首页默认 Agent 的个人会话。它不读取任何空间，也不会向空间发送。 */
export const PERSONAL_CONVERSATION_ID = 'conv-personal-default';

export interface ConversationInfo {
  id: string;
  title: string;
  scope: Scope;
  scopeLabel: string;
}

export const CONVERSATIONS: Record<string, ConversationInfo> = {
  [PERSONAL_CONVERSATION_ID]: {
    id: PERSONAL_CONVERSATION_ID,
    title: '首页对话',
    scope: { kind: 'personal' },
    scopeLabel: '个人 · 默认 Agent',
  },
};

/** 输入框的接收目标。none 表示当前没有可发送的目标，界面显示原因。 */
export type ComposerTarget = { kind: 'conversation'; conversation: ConversationInfo } | { kind: 'none'; reason: string };

export function homeTarget(): ComposerTarget {
  return { kind: 'conversation', conversation: CONVERSATIONS[PERSONAL_CONVERSATION_ID] as ConversationInfo };
}

/** 草稿按会话保存；切换页面或空间只切换显示，不搬运或清空其他会话的草稿。 */
export type DraftsState = Readonly<Record<string, string>>;

export function setDraft(drafts: DraftsState, conversationId: string, text: string): DraftsState {
  if ((drafts[conversationId] ?? '') === text) return drafts;
  return { ...drafts, [conversationId]: text };
}

export const draftsStore = createStore<DraftsState>({});

export const draftActions = {
  set: (conversationId: string, text: string) => draftsStore.set((d) => setDraft(d, conversationId, text)),
};
