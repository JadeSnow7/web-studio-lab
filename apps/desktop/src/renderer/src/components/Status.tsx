import { useEffect, useId, useRef, useState } from 'react';
import type { StatusPhase, StatusScope } from '@wsl/protocol';
import { occlusion } from '../state/occlusion';
import { reportError } from '../state/errors';
import { statusPresentationActions, useStatusView, scopeKey, type StatusView, type StatusViewOptions } from '../state/status-view';

/* 形状沿用 Badges.tsx 的约定（形状 + 颜色，不只靠颜色）；配色由 .status-dot[data-phase] 给出。 */
const SHAPE: Record<StatusPhase, string> = {
  ok: 'dot',
  pending: 'arc',
  active: 'arc',
  idle: 'square',
  failed: 'triangle',
  degraded: 'dashed',
  unknown: 'dashed',
};

type ViewMeta = Pick<StatusView, 'key' | 'domain' | 'phase' | 'label' | 'detail' | 'channel'>;

const statusAttrs = (view: ViewMeta) => ({
  'data-status': `${view.domain}:${view.phase}`,
  'data-status-key': view.key,
  'data-status-channel': view.channel,
});

export function Shape({ phase }: { phase: StatusPhase }) {
  return <span className={`shape shape-${SHAPE[phase]}`} aria-hidden="true" />;
}

/**
 * 环境级状态：只画形状；文字以视觉隐藏文本输出，悬停 title 为 label + detail。
 * visibleLabel：详情页里状态本身就是内容（检查页的执行 / 检查 / 审阅），label 改为可见文本，其余不变。
 * title：覆盖悬停文字（如会话页把对话的版本 · 沙箱 · cwd 并入运行状态点的悬停）。
 */
export function StatusDot({ view, visibleLabel, title }: { view: ViewMeta; visibleLabel?: boolean; title?: string }) {
  return (
    <span
      className="status-dot"
      data-phase={view.phase}
      title={title ?? (view.detail ? `${view.label}（${view.detail}）` : view.label)}
      {...statusAttrs(view)}
    >
      <Shape phase={view.phase} />
      <span className={visibleLabel ? 'status-label' : 'sr-only'}>{view.label}</span>
    </span>
  );
}

function ActionButton({ view, onAction, omit }: { view: StatusView; onAction: (view: StatusView) => void; omit?: readonly string[] }) {
  if (!view.action || omit?.includes(view.action.id)) return null;
  return (
    <button type="button" className="btn btn-small" disabled={view.action.disabled} onClick={() => onAction(view)}>
      {view.action.label}
    </button>
  );
}

/** 形状 + label + 可见的次级 detail（长文本截断，完整内容在 title 中）。 */
function ItemBody({ view }: { view: StatusView }) {
  return (
    <>
      <Shape phase={view.phase} />
      <span className="status-text" title={view.detail ? `${view.label}（${view.detail}）` : undefined}>
        {view.label}
        {view.detail ? <span className="status-detail">{view.detail}</span> : null}
      </span>
    </>
  );
}

/** 播报区域只包文本；动作按钮与菜单放在区域外，数量或禁用状态变化不会重复播报。 */
function Live({ view, role }: { view: StatusView; role: 'status' | 'alert' }) {
  return (
    <div className="status-live" role={role}>
      <ItemBody view={view} />
    </div>
  );
}

/** 「另有 N 项」：展开前进入 occlusion 遮挡集合；方向键移动，Esc 关闭并回到触发器。 */
function MoreMenu({
  scope,
  items,
  onAction,
  omit,
}: {
  scope: StatusScope;
  items: readonly StatusView[];
  onAction: (view: StatusView) => void;
  omit?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const source = `status-more:${scopeKey(scope)}`;
  const menuId = useId();

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    occlusion.close(source);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = async () => {
    if (open) return close(true);
    try {
      if (await occlusion.open(source)) setOpen(true);
    } catch (error) {
      reportError('打开菜单', error);
    }
  };

  useEffect(() => () => occlusion.close(source), [source]);
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // close 只依赖稳定的 source 与 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!buttons.length) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className="status-more" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={trigger}
        className="btn btn-small"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => void show()}
      >
        另有 {items.length} 项
      </button>
      {open ? (
        <div className="status-more-menu" role="menu" id={menuId} aria-label="其他问题">
          {items.map((view) => (
            <button
              key={view.key}
              type="button"
              role="menuitem"
              {...statusAttrs(view)}
              onClick={() => {
                close(true);
                if (view.action && !omit?.includes(view.action.id) && !view.action.disabled) onAction(view);
              }}
            >
              <ItemBody view={view} />
              {view.action && !omit?.includes(view.action.id) ? <span className="muted">（{view.action.label}）</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 每个窗格一个的状态槽，三条通道：
 * 常驻（control > unresolved > progress，全部显示）、问题（一条 + 「另有 N 项」）、提示（一条 +「知道了」）。
 * 三通道全空时不渲染任何元素。动作经调用方注入的 onAction 执行，组件本身不调用 IPC。
 */
export function StatusSlot({
  scope,
  onAction,
  omitActions,
  itemTestId,
  exclude,
}: {
  scope: StatusScope;
  onAction: (view: StatusView) => void;
  /** 窗格工具栏已有同名控件的动作 id；槽里不再重复渲染按钮（避免同名按钮重复）。 */
  omitActions?: readonly string[];
  /** 按条目附加 data-testid（既有合同用例按它定位）；返回 undefined 则不加。 */
  itemTestId?: (view: StatusView) => string | undefined;
  /** 同 scope 里已有自己呈现方式的视图（如会话页自带结果区的观察）；见 StatusViewOptions.exclude，需稳定引用。 */
  exclude?: StatusViewOptions['exclude'];
}) {
  const { persistent, problem, more, notice } = useStatusView(scope, { exclude });
  if (!persistent.length && !problem && !notice) return null;
  return (
    <div className="status-slot">
      {persistent.map((view) => (
        <div key={view.key} className="status-item" {...statusAttrs(view)} data-testid={itemTestId?.(view)}>
          <Live view={view} role="status" />
          <ActionButton view={view} onAction={onAction} omit={omitActions} />
        </div>
      ))}
      {problem ? (
        <div className="status-item" {...statusAttrs(problem)} data-testid={itemTestId?.(problem)}>
          <Live view={problem} role="alert" />
          <ActionButton view={problem} onAction={onAction} omit={omitActions} />
          {more.length ? <MoreMenu scope={scope} items={more} onAction={onAction} omit={omitActions} /> : null}
        </div>
      ) : null}
      {notice ? (
        <div className="status-item" {...statusAttrs(notice)} data-testid={itemTestId?.(notice)}>
          <Live view={notice} role="status" />
          <button type="button" className="btn btn-small" onClick={() => statusPresentationActions.acknowledge(scope, notice)}>
            知道了
          </button>
        </div>
      ) : null}
    </div>
  );
}
