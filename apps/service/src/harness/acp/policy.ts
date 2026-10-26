import type { PermissionOption, PermissionOutcome, RequestPermissionParams } from './protocol';
import type { PermissionDecider } from './turn';

/**
 * ACP 权限审批策略（W3b 起，W4b 修改）。
 *
 * Codex 在 sbx guest 内以 `--sandbox workspace-write` 运行，无需逐项审批即可读写工作区、执行命令。ACP Agent 逐项申请权限，
 * 这里按同样的边界自动处理：工作区内的读、写、删、移动、搜索、执行、思考与其他工具（含 wsl_space MCP）放行一次。
 * 联网获取（fetch）、切换模式（switch_mode）与未知类型交给用户逐项决定（W4-8 A）；只提供一次性选项（W4-11 A）。
 * 真正的隔离边界仍是 sbx guest 本身。
 */
const ALLOWED_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'other']);

export interface ApprovalHandlers {
  /** 直接拒绝时调用，用于在会话中记录原因。 */
  onDeny(params: RequestPermissionParams, reason: string): void;
  /** 交给用户决定；options 只含一次性选项，至少有一个允许。 */
  ask(params: RequestPermissionParams, options: PermissionOption[]): Promise<PermissionOutcome>;
}

export function approvalPolicy(handlers: ApprovalHandlers): PermissionDecider {
  return (params) => {
    const kind = params.toolCall.kind ?? 'unknown';
    const allow = params.options.find((option) => option.kind === 'allow_once');
    const reject = (reason: string): PermissionOutcome => {
      handlers.onDeny(params, reason);
      const option = params.options.find((item) => item.kind === 'reject_once');
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    };
    if (!allow) return reject('没有一次性允许选项');
    if (ALLOWED_KINDS.has(kind)) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    return handlers.ask(
      params,
      params.options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once'),
    );
  };
}
