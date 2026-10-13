import type { ExecutionStatus } from '@wsl/protocol';

/** 固定比赛执行与验收服务的状态；空间会话 Runner 的连接状态由 chatStatus 单独报告。 */
export function getExecutionStatus(): ExecutionStatus {
  return {
    available: false,
    reason: '固定比赛执行与验收服务（T04）尚未接入。空间任务已接入 sbx Codex CLI Runner；当前连接与可用性请查看沙箱对话状态。',
    harness: { name: 'Codex CLI', state: 'integrated', version: null, model: null },
  };
}
