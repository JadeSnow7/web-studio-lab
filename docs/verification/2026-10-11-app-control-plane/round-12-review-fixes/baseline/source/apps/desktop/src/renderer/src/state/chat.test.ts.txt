import { describe, expect, it } from 'vitest';
import { projectConversation, type ChatState } from './chat';
import type { ChatConversation } from '@wsl/protocol';
const initial: ChatState = { status: null, conversations: {}, errors: {}, pending: {} };
const snapshot: ChatConversation = {
  conversationId: 'conv-personal-default',
  generation: 'new',
  seq: 10,
  threadId: null,
  turnId: null,
  state: 'idle',
  messages: [],
  cleanupPending: false,
  toolExecutions: [],
  warnings: [],
  error: null,
};
describe('服务会话投影', () => {
  it('旧查询与 reset 前的迟到事件不能覆盖新会话', () => {
    const state = projectConversation(initial, snapshot);
    expect(projectConversation(state, { ...snapshot, generation: 'old', seq: 9, state: 'running' })).toBe(state);
    expect(projectConversation(state, snapshot)).toBe(state);
  });
  it('个人与空间消息互不迁移', () => {
    const state = projectConversation(projectConversation(initial, snapshot), {
      ...snapshot,
      conversationId: 'conv-space-taskflow-demo-impl',
      seq: 11,
    });
    expect(state.conversations['conv-personal-default']).toBe(snapshot);
    expect(Object.keys(state.conversations)).toHaveLength(2);
  });
});
