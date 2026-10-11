import { describe, expect, it } from 'vitest';
import { CONVERSATIONS, homeTarget, PERSONAL_CONVERSATION_ID, setDraft } from './drafts';

describe('发送目标', () => {
  it('全局输入保持个人作用域，不沿用后台空间', () => {
    const target = homeTarget();
    expect(target.kind === 'conversation' && target.conversation.scope).toEqual({ kind: 'personal' });
  });
  it('个人会话目录不包含空间可写入口', () => {
    expect(Object.values(CONVERSATIONS).every((c) => c.scope.kind === 'personal')).toBe(true);
  });
  it('首页输入只指向个人会话', () => {
    const target = homeTarget();
    expect(target.kind === 'conversation' && target.conversation.id).toBe(PERSONAL_CONVERSATION_ID);
    expect(target.kind === 'conversation' && target.conversation.scope).toEqual({ kind: 'personal' });
  });
});

describe('草稿按会话保存', () => {
  it('不同会话的草稿互不替换', () => {
    const space = 'session-space-stable-id';
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
