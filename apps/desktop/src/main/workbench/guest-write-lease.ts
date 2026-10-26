import type { ChatConversation, ChatSlot } from '@wsl/protocol';

/**
 * sandbox guest 工作区的写入许可（W0）。
 *
 * 每次 send 先登记独立票据。查询/取消快照不能证明排队中的 send 已结束；
 * 只有对应的 service 回执结算票据，且所有票据均已结算、执行已停止并确认清理后才释放。
 * 纯内存状态，由 Main ChatService 这一所有轮次的唯一汇合点持有。
 */
export class GuestWriteLease {
  private holder: {
    slot: ChatSlot;
    acquiredAtSeq: number;
    pending: Set<symbol>;
    observed: { seq: number; settled: boolean } | null;
  } | null = null;

  current(): ChatSlot | null {
    return this.holder?.slot ?? null;
  }

  /** 同槽发送也各自登记；一个发送被拒绝不能结算另一个尚未返回的发送。 */
  acquire(slot: ChatSlot, knownSeq: number): symbol {
    if (this.holder && this.holder.slot !== slot) throw new Error(conflictMessage(this.holder.slot));
    this.holder ??= { slot, acquiredAtSeq: knownSeq, pending: new Set(), observed: null };
    const ticket = Symbol(slot);
    this.holder.pending.add(ticket);
    return ticket;
  }

  /** 新快照只更新执行事实，不结算任何 send 票据。 */
  observe(conversation: ChatConversation) {
    if (!this.holder || conversation.conversationId !== this.holder.slot) return;
    if (conversation.seq <= this.holder.acquiredAtSeq || conversation.seq <= (this.holder.observed?.seq ?? -1)) return;
    this.holder.observed = { seq: conversation.seq, settled: settled(conversation) };
    this.releaseIfSettled();
  }

  /**
   * 只用于方法/会话身份已校验的 send 回执（成功或明确错误），不用于传输失败。
   * latest 是 Main 已采信的最新快照。显式拒绝且从未见到会话时，没有执行清理义务。
   */
  sendSettled(ticket: symbol, latest: ChatConversation | undefined) {
    if (!this.holder?.pending.has(ticket)) return;
    if (latest && (latest.conversationId !== this.holder.slot || latest.seq < this.holder.acquiredAtSeq)) return;
    this.holder.pending.delete(ticket);
    if (latest && latest.seq >= (this.holder.observed?.seq ?? -1)) {
      this.holder.observed = { seq: latest.seq, settled: settled(latest) };
    }
    this.releaseIfSettled(true);
  }

  private releaseIfSettled(explicitReply = false) {
    if (this.holder && this.holder.pending.size === 0 && (this.holder.observed?.settled ?? explicitReply)) this.holder = null;
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
