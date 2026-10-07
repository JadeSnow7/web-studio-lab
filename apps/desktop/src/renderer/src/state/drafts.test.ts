import { describe, expect, it } from 'vitest';
import { DEMO_SPACE } from '../domain/space';
import { homeTarget, PERSONAL_CONVERSATION_ID, setDraft, spaceConversationId, spacePanelTarget } from './drafts';

describe('发送目标', () => {
  it('个人作用域下右栏空间分区没有发送目标，不沿用后台空间', () => {
    expect(spacePanelTarget({ kind: 'personal' })).toEqual({ kind: 'none', reason: '选择空间后对话' });
  });
  it('空间作用域锁定该空间的会话', () => {
    const target = spacePanelTarget({ kind: 'space', spaceId: DEMO_SPACE.id });
    expect(target.kind === 'conversation' && target.conversation.id).toBe(spaceConversationId(DEMO_SPACE.id));
  });
  it('首页输入只指向个人会话', () => {
    const target = homeTarget();
    expect(target.kind === 'conversation' && target.conversation.id).toBe(PERSONAL_CONVERSATION_ID);
    expect(target.kind === 'conversation' && target.conversation.scope).toEqual({ kind: 'personal' });
  });
});

describe('草稿按会话保存', () => {
  it('不同会话的草稿互不替换', () => {
    const space = spaceConversationId(DEMO_SPACE.id);
    let drafts = setDraft({}, space, '空间草稿');
    drafts = setDraft(drafts, PERSONAL_CONVERSATION_ID, '个人草稿');
    expect(drafts[space]).toBe('空间草稿');
    expect(drafts[PERSONAL_CONVERSATION_ID]).toBe('个人草稿');
  });
  it('内容不变时返回同一对象', () => {
    const drafts = setDraft({}, 'a', 'x');
    expect(setDraft(drafts, 'a', 'x')).toBe(drafts);
  });
});
