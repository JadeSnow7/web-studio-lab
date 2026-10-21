import type { EduVerificationView } from '@wsl/protocol';

export function verificationPresentation(view: EduVerificationView | null | undefined, now: number) {
  const status = view?.status;
  const locked =
    !!view &&
    (view.recoveryRequired || (view.admissionRecovery ? view.admissionRecovery.maintenanceLocked : !status || status.maintenanceLocked));
  const phase = view?.admissionRecovery?.phase ?? status?.phase;
  const labels = {
    preparing: '正在准备发音验证；所有空间的维护已暂停',
    active: '发音验证已开启；所有空间的维护已暂停',
    revoking: '正在撤销评分；维护仍暂停',
    restoring: '正在恢复默认维护模式；维护仍暂停',
    revoked: '评分已撤销，应用已停止；请退出验证以恢复维护',
    ended: '已退出验证，维护已恢复；默认评分关闭',
    failed: locked ? '发音验证未完成，维护仍暂停' : '发音验证未开启；默认维护模式保持不变',
  };
  return {
    locked,
    label:
      view?.admissionRecovery && ['revoking', 'restoring'].includes(view.admissionRecovery.phase)
        ? labels[view.admissionRecovery.phase]
        : view?.recoveryRequired
          ? '验证回收或恢复尚未确认；请核对并恢复维护'
          : phase
            ? labels[phase]
            : view
              ? labels.preparing
              : '默认维护模式：评分关闭',
    remainingCalls: Math.max(0, 2 - (status?.callsUsed ?? 0)),
    remainingSeconds: status ? Math.max(0, Math.ceil((status.lease.expiresAtMs - now) / 1000)) : null,
    canEnd: locked && !!view?.target && !view.recoveryRequired && !['revoking', 'restoring'].includes(phase ?? ''),
    canReconcile: !!view?.recoveryRequired && !!(view.target || view.original),
  };
}
