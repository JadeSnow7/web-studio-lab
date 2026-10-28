import type { RequestPermissionParams } from './protocol';
import type { PermissionDecider } from './turn';

/**
 * 与 Codex `--sandbox workspace-write` 对等的审批策略（W3b）。
 *
 * Codex 在 sbx guest 内无需逐项审批即可读写工作区、执行命令，网络默认关闭。ACP Agent 逐项申请权限，
 * 这里按同样的边界自动处理：工作区内的读、写、删、移动、搜索、执行、思考与其他工具（含 wsl_space MCP）放行一次；
 * 联网获取（fetch）与切换模式（switch_mode）以及未知类型一律拒绝。真正的隔离边界仍是 sbx guest 本身。
 * 交给用户逐项审批的界面属于 W4。
 */
const ALLOWED_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'other']);

export function workspaceWritePolicy(onDeny?: (params: RequestPermissionParams, reason: string) => void): PermissionDecider {
  return (params) => {
    const kind = params.toolCall.kind ?? 'unknown';
    const allow = params.options.find((option) => option.kind === 'allow_once');
    const reject =
      params.options.find((option) => option.kind === 'reject_once') ?? params.options.find((option) => option.kind === 'reject_always');
    if (ALLOWED_KINDS.has(kind) && allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    onDeny?.(params, ALLOWED_KINDS.has(kind) ? '没有一次性允许选项' : `不在工作区写入范围：${kind}`);
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
  };
}
