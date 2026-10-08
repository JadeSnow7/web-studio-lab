import type { ReactNode } from 'react';
import type { RunRecord, RunStatus } from '@wsl/protocol';
import { Icon } from './Icon';

/** 演示数据标识：所有演示内容都必须带上它，避免与真实结果混淆。 */
export function DemoBadge({ label = '演示数据' }: { label?: string }) {
  return (
    <span className="badge badge-demo" title="写死在仓库里的演示数据，不是真实运行结果">
      {label}
    </span>
  );
}

const STATUS_META: Record<RunStatus, { label: string; tone: string; shape: string }> = {
  queued: { label: '排队中', tone: 'neutral', shape: 'ring' },
  running: { label: '运行中', tone: 'info', shape: 'ring' },
  cancelling: { label: '取消中', tone: 'warn', shape: 'square' },
  passed: { label: '验收通过', tone: 'ok', shape: 'dot' },
  failed: { label: '验收失败', tone: 'bad', shape: 'triangle' },
  inconclusive: { label: '无法判断', tone: 'neutral', shape: 'dashed' },
  timed_out: { label: '超时', tone: 'warn', shape: 'square' },
  cancelled: { label: '已取消', tone: 'neutral', shape: 'square' },
};

export function runStatusLabel(status: RunStatus): string {
  return STATUS_META[status].label;
}

/** 状态同时用文字和形状表达，不只靠颜色区分。 */
export function StatusPill({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`pill pill-${meta.tone}`}>
      <span className={`shape shape-${meta.shape}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

const REVIEW_LABEL: Record<RunRecord['review']['state'], string> = {
  not_ready: '无需审阅',
  pending: '等待开发者审阅',
  accepted: '已接受',
  changes_requested: '已要求修改',
};

export function ReviewPill({ review }: { review: RunRecord['review'] }) {
  const tone =
    review.state === 'accepted' ? 'ok' : review.state === 'pending' ? 'review' : review.state === 'changes_requested' ? 'warn' : 'neutral';
  return <span className={`pill pill-${tone}`}>{REVIEW_LABEL[review.state]}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'history'; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'note'}>
      <Icon name={tone === 'info' ? 'info' : tone === 'history' ? 'history' : 'alert'} size={15} />
      <div>{children}</div>
    </div>
  );
}

/** 不可用的动作：按钮禁用，同时把原因写在旁边，不只放在 tooltip 里。 */
export function DisabledAction({ label, reason, icon }: { label: string; reason: string; icon?: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <div className="disabled-action">
      <button type="button" className="btn" disabled>
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </button>
      <span className="disabled-reason">{reason}</span>
    </div>
  );
}
