import type { ExecutionStatus } from '@wsl/protocol';
import { PRODUCT_CHECKER } from './workbench/checker';

/** 固定比赛执行与验收服务的状态；空间会话 Runner 的连接状态由 chatStatus 单独报告。 */
export function getExecutionStatus(): ExecutionStatus {
  return {
    available: false,
    reason: '固定比赛执行与验收服务（T04）尚未接入。空间任务已接入 sbx Codex CLI Runner；当前连接与可用性请查看沙箱对话状态。',
    harness: { harnessId: 'codex', name: 'Codex CLI', state: 'integrated', version: null, model: null },
    // 产品检查器能力（OPS-1 S3）与 runValidation 同源（workbench/checker.ts）；只改变呈现，接受仍要求 passed 且 current。
    checker: { ...PRODUCT_CHECKER },
  };
}
