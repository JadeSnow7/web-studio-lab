import { useEffect, useRef } from 'react';
import { useStore } from '../lib/store';
import { chatActions, chatStore } from '../state/chat';

/** 首页、会话页与右栏展示同一份服务会话；演示消息不进入真实历史。 */
export function ChatMessages({ conversationId }: { conversationId: string }) {
  const conversation = useStore(chatStore, (state) => state.conversations[conversationId]);
  const error = useStore(chatStore, (state) => state.errors[conversationId]);
  const pending = useStore(chatStore, (state) => state.pending[conversationId]);
  const status = useStore(chatStore, (state) => state.status);
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    if (nearBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [conversation]);
  const busy = conversation?.state === 'running' || conversation?.state === 'cancelling';
  return (
    <>
      <div className="row space-between">
        <span className="muted small" aria-label="对话执行环境">
          sbx · {status?.sandbox ?? '未选择沙箱'} · {status?.cwd ?? '工作目录未读取'} · Codex CLI ·{' '}
          {status?.available ? status.version : (status?.reason ?? '检查中')} · 应用内消息仅本次启动可见
        </span>
        <button type="button" className="btn btn-ghost" disabled={pending || busy} onClick={() => void chatActions.reset(conversationId)}>
          开始新对话
        </button>
      </div>
      <div
        className="message-list"
        ref={list}
        role="log"
        aria-live="polite"
        aria-label="Codex 对话消息"
        onScroll={() => {
          const element = list.current;
          if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
        }}
      >
        {conversation?.messages.length ? (
          conversation.messages.map((message) => (
            <div key={message.id} className={`message message-${message.role === 'user' ? 'user' : 'agent'}`}>
              <p style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p>
              <span>{message.role === 'user' ? '你' : 'Codex CLI'}</span>
            </div>
          ))
        ) : (
          <p className="muted">还没有消息。发送后将在这里显示真实回复。</p>
        )}
        {conversation?.toolExecutions.length ? (
          <details className="chat-tools">
            <summary>工具执行 · {conversation.toolExecutions.length} 条</summary>
            {conversation.toolExecutions.map((tool) => (
              <div key={`${tool.turnId}:${tool.id}`} className="stack-8">
                <code className="wrap">{tool.command}</code>
                <pre>{tool.output}</pre>
                <span className="muted small">
                  退出码 {tool.exitCode ?? '未返回'}
                  {tool.truncated ? ' · 输出已截断' : ''}
                </span>
              </div>
            ))}
          </details>
        ) : null}
        {conversation?.warnings.map((warning) => (
          <p key={warning} className="text-warn" role="status">
            {warning}
          </p>
        ))}
        {busy ? (
          <div className="row space-between" role="status">
            <span>{conversation.state === 'cancelling' ? '正在取消并等待进程退出…' : '正在等待 Codex 回复…'}</span>
            <button
              type="button"
              className="btn"
              disabled={pending || conversation.state === 'cancelling'}
              onClick={() => void chatActions.cancel(conversationId)}
            >
              取消回复
            </button>
          </div>
        ) : null}
        {conversation?.state === 'cancelled' ? (
          <p role="status" className="muted">
            回复已取消，进程已退出。
          </p>
        ) : null}
        {error || conversation?.error ? (
          <p role="alert" className="text-warn">
            {error ?? conversation?.error}
          </p>
        ) : null}
      </div>
    </>
  );
}
