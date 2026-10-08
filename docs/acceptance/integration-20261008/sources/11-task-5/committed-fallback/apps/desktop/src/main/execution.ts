import type { ExecutionStatus } from '@wsl/protocol';

/**
 * 执行服务的接入点。T04 实现独立 Node 执行服务后，由这里报告真实状态并转发 run 请求；
 * 在那之前只如实报告“未接入”，不提供任何启动 run 的通道。
 */
export function getExecutionStatus(): ExecutionStatus {
  return {
    available: false,
    reason: '执行服务（T04）与 Codex CLI 通路（T02）尚未接入，本版本不启动真实 run。',
    harness: { name: 'Codex CLI', state: 'not_integrated', version: null, model: null },
  };
}
