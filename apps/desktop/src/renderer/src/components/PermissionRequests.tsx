import { useState } from 'react';
import type { ChatConversation, PermissionRequest } from '@wsl/protocol';

const OPTION_LABEL: Record<PermissionRequest['options'][number]['kind'], string> = {
  allow_once: '允许一次',
  reject_once: '拒绝',
};

/**
 * 待用户决定的 Agent 权限请求（W4b）。只展示与提交回复；请求是否仍待决、选项是否有效由 Main 与执行服务核对，
 * 结果以新的会话快照呈现。标题与类型来自 Agent，作为纯文本显示。
 */
export function PermissionRequests({
  conversation,
  onAnswer,
}: {
  conversation: ChatConversation | null | undefined;
  onAnswer: (requestId: string, optionId: string | null) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const requests = conversation?.state === 'running' ? (conversation.permissionRequests ?? []) : [];
  if (!requests.length) return null;
  return (
    <div className="permission-requests" role="group" aria-label="待决定的权限请求">
      {requests.map((request) => (
        <div key={request.requestId} className="notice" role="alert" data-request-id={request.requestId}>
          <p>
            Agent 请求权限：<strong>{request.title}</strong>（{request.kind}）
          </p>
          <p className="muted small">截止 {new Date(request.expiresAt).toLocaleTimeString()} 前未回复将按拒绝处理；只对这一次有效。</p>
          <div className="row">
            {request.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                className={option.kind === 'allow_once' ? 'btn' : 'btn btn-ghost'}
                disabled={busy !== null}
                onClick={() => {
                  setBusy(request.requestId);
                  void onAnswer(request.requestId, option.optionId).finally(() => setBusy(null));
                }}
              >
                {OPTION_LABEL[option.kind]}
              </button>
            ))}
            {!request.options.some((option) => option.kind === 'reject_once') && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(request.requestId);
                  void onAnswer(request.requestId, null).finally(() => setBusy(null));
                }}
              >
                拒绝
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
