import type { CheckerCapability, CheckerUnavailableReason, WorkbenchRun } from '@wsl/protocol';

/**
 * 产品检查器在 Main 中的唯一来源（OPS-1 S3）：`ExecutionStatus.checker` 发布的能力与 `runValidation` 的结果都由它派生，
 * 不能一边改动而另一边不变。真正的检查器实现尚未接入，因此恒为未接入。
 */
export const PRODUCT_CHECKER: Readonly<CheckerCapability> = { connected: false, reason: 'not_integrated' };

const UNAVAILABLE_VALIDATION_REASON: Record<CheckerUnavailableReason, string> = {
  not_integrated: '独立检查适配器尚未接入；Agent 文本不能作为检查结果',
};

/**
 * `runValidation` 写入的检查记录。未接入时行为不变：记 blocked 与原因文字，从不产生 passed。
 * 能力若显示已接入却没有检查器实现，拒绝执行，而不是悄悄记成“未接入”。
 */
export function validationResult(checker: Readonly<CheckerCapability> = PRODUCT_CHECKER): WorkbenchRun['validation'] {
  if (checker.connected) throw new Error('unsupported: 检查器能力显示已接入，但 Main 没有检查器实现');
  return { state: 'blocked', applicability: 'unknown', reason: UNAVAILABLE_VALIDATION_REASON[checker.reason] };
}
