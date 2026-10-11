import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../lib/store';
import { draftActions, draftsStore, type ComposerTarget } from '../state/drafts';
import { chatActions, chatBlockedReason, chatStore } from '../state/chat';
import { PersonalReferences } from './PersonalReferences';
import { Icon } from '../components/Icon';

interface ComposerProps {
  target: ComposerTarget;
  /** 不能发送的原因；为 null 时允许发送。为 null 时使用真实聊天状态。 */
  sendBlockedReason: string | null;
  placeholder: string;
  harnessLabel: string;
  rows?: number;
  /** 输入区说明（不再常驻可见）：作为输入框的可访问描述与悬停 title。 */
  descriptions?: readonly string[];
}

/** 常驻的快捷键说明收进发送按钮的悬停；阻止原因优先。 */
const SEND_HINT = 'Enter 发送 · Shift+Enter 换行 · 草稿按会话保存';

/**
 * 会话输入框。草稿按会话 ID 保存在 draftsStore，右栏、会话页与首页读写同一份草稿；
 * 输入法组词期间按 Enter 不提交。
 */
export function Composer({ target, sendBlockedReason, placeholder, harnessLabel, rows = 2, descriptions = [] }: ComposerProps) {
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationId = target.kind === 'conversation' ? target.conversation.id : null;
  const draft = useStore(draftsStore, (d) => (conversationId ? (d[conversationId] ?? '') : ''));
  useStore(chatStore, (state) => state);
  const blocked = sendBlockedReason ?? (conversationId ? chatBlockedReason(conversationId) : null);
  const [notice, setNotice] = useState<string | null>(null);

  if (target.kind === 'none') {
    return (
      <div className="composer composer-empty">
        <span>{target.reason}</span>
        <button type="button" className="icon-btn" aria-label="发送（不可用）" disabled>
          <Icon name="send" size={15} />
        </button>
      </div>
    );
  }

  const attemptSend = () => {
    if (draft.trim() === '') return;
    if (blocked) {
      setNotice(`未发送：${blocked}`);
      return;
    }
    void chatActions.send(target.conversation.id, draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 输入法组词中的 Enter 用于确认候选词，不能当作发送。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    attemptSend();
  };

  return (
    <div className="composer">
      {/* 视觉隐藏但保留：输入框的可访问名称不变。 */}
      <label htmlFor={inputId} className="sr-only">
        发送到 · {target.conversation.scopeLabel} / {target.conversation.title} / {harnessLabel}
      </label>
      {descriptions.map((text, index) => (
        <span key={index} id={`${inputId}-desc-${index}`} className="sr-only">
          {text}
        </span>
      ))}
      <PersonalReferences disabled={!!blocked} />
      <textarea
        className="resize-none"
        ref={input}
        id={inputId}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        title={descriptions.length ? descriptions.join(' ') : undefined}
        aria-describedby={descriptions.length ? descriptions.map((_, index) => `${inputId}-desc-${index}`).join(' ') : undefined}
        onChange={(event) => {
          setNotice(null);
          draftActions.set(target.conversation.id, event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="composer-foot">
        {notice ? <span className="composer-notice">{notice}</span> : null}
        <button
          type="button"
          className="icon-btn primary"
          aria-label="发送"
          aria-disabled={blocked !== null}
          title={blocked ?? SEND_HINT}
          onClick={() => {
            attemptSend();
            input.current?.focus();
          }}
        >
          <Icon name="send" size={15} />
        </button>
      </div>
    </div>
  );
}
