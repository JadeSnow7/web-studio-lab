import type { ChatConversation, ChatSlot } from '@wsl/protocol';

/**
 * sandbox guest 工作区的写入许可（W0）。
 *
 * 所有 Codex 轮次都在同一个 guest 工作目录内以 workspace-write 运行，因此同一时刻只允许一个会话槽持有许可。
 * 许可只在持有者出现晚于取得时的快照、且该快照已停止并确认清理后释放；取消或失败但清理未确认时继续占用。
 * 纯内存状态，不依赖 Electron，便于单元测试；由 Main ChatService 这一所有轮次的唯一汇合点持有。
 */
export class GuestWriteLease {
  private holder: { slot: ChatSlot; acquiredAtSeq: number } | null = null;

  current(): ChatSlot | null {
    return this.holder?.slot ?? null;
  }

  /** 发送前取得许可；被其他会话槽占用时抛出 conflict。同一会话槽重复取得保持原记录。 */
  acquire(slot: ChatSlot, knownSeq: number) {
    if (this.holder && this.holder.slot !== slot) throw new Error(conflictMessage(this.holder.slot));
    if (!this.holder) this.holder = { slot, acquiredAtSeq: knownSeq };
  }

  /** 每个已采信的会话快照都交给许可判断是否可以释放。 */
  observe(conversation: ChatConversation) {
    if (!this.holder || conversation.conversationId !== this.holder.slot) return;
    if (conversation.seq <= this.holder.acquiredAtSeq) return;
    if (settled(conversation)) this.holder = null;
  }

  /**
   * 发送请求被拒绝后调用。latest 为该会话槽当前已知的最新快照。
   * 没有晚于取得时的快照说明轮次未启动，可以释放；否则按快照判断。服务通信失败时调用方不应调用本方法。
   */
  sendRejected(slot: ChatSlot, latest: ChatConversation | undefined) {
    if (!this.holder || this.holder.slot !== slot) return;
    if (!latest || latest.seq <= this.holder.acquiredAtSeq || settled(latest)) this.holder = null;
  }
}

function settled(conversation: ChatConversation) {
  return conversation.state !== 'running' && conversation.state !== 'cancelling' && !conversation.cleanupPending;
}

/** label 为面向用户的会话名称；缺省时使用会话槽身份。消息保留会话槽身份以便诊断。 */
export function conflictMessage(holder: ChatSlot, label?: string) {
  const who = label ? `「${label}」（${holder}）` : holder;
  return `conflict: sandbox 工作区正被会话 ${who} 写入；请等它结束，或取消并确认清理后再试`;
}
