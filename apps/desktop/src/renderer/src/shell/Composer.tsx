import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../lib/store';
import { draftActions, draftsStore, type ComposerTarget } from '../state/drafts';
import { chatActions, chatBlockedReason, chatStore } from '../state/chat';
import { Icon } from '../components/Icon';

interface ComposerProps {
  target: ComposerTarget;
  /** 不能发送的原因；为 null 时允许发送。为 null 时使用真实聊天状态。 */
  sendBlockedReason: string | null;
  placeholder: string;
  harnessLabel: string;
  rows?: number;
}

/**
 * 会话输入框。草稿按会话 ID 保存在 draftsStore，右栏、会话页与首页读写同一份草稿；
 * 输入法组词期间按 Enter 不提交。
 */
export function Composer({ target, sendBlockedReason, placeholder, harnessLabel, rows = 2 }: ComposerProps) {
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
      <label htmlFor={inputId} className="composer-target">
        发送到 · {target.conversation.scopeLabel} / {target.conversation.title} / {harnessLabel}
      </label>
      <textarea
        className="resize-none"
        ref={input}
        id={inputId}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          setNotice(null);
          draftActions.set(target.conversation.id, event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="composer-foot">
        <span className={notice ? 'composer-notice' : 'composer-hint'}>{notice ?? 'Enter 发送 · Shift+Enter 换行 · 草稿按会话保留'}</span>
        <button
          type="button"
          className="icon-btn primary"
          aria-label="发送"
          aria-disabled={blocked !== null}
          title={blocked ?? '发送'}
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
