import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { StatusScope, WorkbenchResource } from '@wsl/protocol';
import { workspaceCommand, workspaceStore } from '../state/workspace';
import { useStore } from '../lib/store';
import { captureContext, cancelContextCapture } from '../state/capture';
import { locateSession } from '../state/location';
import { Icon } from '../components/Icon';
import { StatusDot, StatusSlot } from '../components/Status';
import { spaceActions } from '../state/space-ui';
import { useCatalogMutation } from '../state/catalog';
import { occlusion } from '../state/occlusion';
import { reportError } from '../state/errors';
import { ackScope, statusPresentationActions, useStatusViewByKey, type StatusView } from '../state/status-view';

const PICKING_HINT = '选择中，先取消选择';
const CAPTURE_GUIDANCE = '请在此网页的“关联会话”中明确选择会话，再点击“采集到关联会话”。没有会话时可新建关联会话；采集结果保存在所选会话。';

/**
 * 工具栏弹出层（「采集到会话 ⌄」与「⋯」）：展开前进入 occlusion 遮挡集合（原生网页让位），关闭时释放。
 * menu：方向键 / Home / End 在菜单项间移动；dialog（内含表单控件，非模态）：方向键只在按钮间移动，不抢 select 的方向键。
 * Esc 关闭并回到触发器；点击外部或焦点移出弹出层关闭；窗格被隐藏时关闭。
 */
function ToolbarPopup({
  source,
  role,
  label,
  triggerClassName,
  triggerLabel,
  triggerContent,
  hidden,
  disabled,
  title,
  children,
}: {
  source: string;
  role: 'menu' | 'dialog';
  /** 弹出层的可访问名称。 */
  label: string;
  triggerClassName: string;
  /** 触发器可访问名称；缺省取按钮内的文字。 */
  triggerLabel?: string;
  triggerContent: ReactNode;
  hidden: boolean;
  disabled?: boolean;
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const popupId = useId();
  const triggerId = useId();
  const focusable = role === 'menu' ? '[role="menuitem"]:not(:disabled)' : 'select, button:not(:disabled)';

  const close = (restoreFocus = true) => {
    setOpen(false);
    occlusion.close(source);
    if (restoreFocus) document.getElementById(triggerId)?.focus();
  };
  const show = async () => {
    if (open) return close();
    try {
      if (!(await occlusion.open(source))) return;
    } catch (error) {
      reportError('打开菜单', error);
      return;
    }
    if (!mounted.current) occlusion.close(source);
    else setOpen(true);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      occlusion.close(source);
    };
  }, [source]);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>(focusable)?.focus();
    // 只在展开时移动一次焦点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // 选择中禁用触发器时同步收起（渲染期调整 open，遮挡集合在效果里释放）。
  if (disabled && open) setOpen(false);
  useEffect(() => {
    if (disabled) occlusion.close(source);
  }, [disabled, source]);
  // 窗格被隐藏（切换标签 / 空间）时收起；新建关联会话会让窗格短暂切走再切回，所以持续隐藏才收起。
  useEffect(() => {
    if (!hidden || !open) return;
    const timer = setTimeout(() => close(false), 400);
    return () => clearTimeout(timer);
    // close 只依赖稳定的 source 与 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!open) {
      if (role === 'menu' && event.key === 'ArrowDown' && event.target === trigger.current) {
        event.preventDefault();
        void show();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    // select 自己使用方向键改变选项。
    if (event.target instanceof HTMLSelectElement) return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(focusable) ?? []);
    if (!items.length) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div
      className="browser-popup-anchor"
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) close(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        id={triggerId}
        className={triggerClassName}
        aria-label={triggerLabel}
        title={title}
        disabled={disabled}
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={() => void show()}
      >
        {triggerContent}
      </button>
      {open ? (
        <div className="browser-popup" ref={panel} role={role} id={popupId} aria-label={label} tabIndex={-1}>
          {children(() => close())}
        </div>
      ) : null}
    </div>
  );
}

export function Browser({
  workspaceId,
  resource,
  visible,
  occluded,
}: {
  workspaceId: string;
  resource: WorkbenchResource;
  visible: boolean;
  occluded: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // Focus alone freezes the displayed value; only edited/submitted drafts survive blur.
  const dirtyDraft = useRef(false);
  const composing = useRef(false);
  const draftVersion = useRef(0);
  const navigationRequest = useRef(0);
  const pendingNavigation = useRef<{ version: number; url: string } | null>(null);
  const p = resource.preview;
  const projectedUrl = p?.page.url ?? resource.url ?? '';
  useLayoutEffect(() => {
    if (visible) return;
    draftVersion.current++;
    composing.current = false;
    if (!dirtyDraft.current) setDraft(null);
    address.current?.blur();
  }, [visible]);
  const workspace = useStore(workspaceStore, (s) => s.snapshot?.workspaces.find((w) => w.workspaceId === workspaceId));
  const managedAppInstanceId = resource.appProjectId ? workspace?.managedApp?.appInstanceId : null;
  const [associatedSessionId, setAssociatedSessionId] = useState('');
  const capture = () => captureContext(workspaceId, associatedSessionId, resource.resourceId);
  const [creatingSession, setCreatingSession] = useState(false);
  const creating = useRef(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const createAssociatedSession = async () => {
    if (creating.current || !workspace) return;
    creating.current = true;
    setCreatingSession(true);
    try {
      const result = await workspaceCommand(workspaceId, { type: 'createTab', kind: 'session', title: `${resource.title} · 会话` });
      if (!result?.ok) return;
      const session = result.snapshot.workspaces
        .find((w) => w.workspaceId === workspaceId)!
        .sessions.find((s) => !workspace.sessions.some((old) => old.sessionId === s.sessionId));
      if (!session) throw new Error('新建会话成功但未返回会话身份');
      setAssociatedSessionId(session.sessionId);
      const tab = workspace.tabs.find((t) => t.targetRef.resourceId === resource.resourceId)!;
      await workspaceCommand(workspaceId, { type: 'activateTab', tabId: tab.tabId });
    } finally {
      creating.current = false;
      setCreatingSession(false);
    }
  };
  const { resourceId } = resource;
  const scope = useMemo<StatusScope>(() => ({ kind: 'resource', workspaceId, resourceId }), [workspaceId, resourceId]);
  // 受管 App 的服务状态：事实层 app:<workspaceId>:state，降为工具栏上的 StatusDot。
  const appState = useStatusViewByKey({ kind: 'workspace', workspaceId }, `app:${workspaceId}:state`);
  const resourceAction = useCatalogMutation();
  const resourceActionName = useRef('收藏到资源');
  // 界面操作失败是一次性事件，进 Toast；成功结果是 hint（提示通道），用户确认或与窗格交互后消失。
  useEffect(() => {
    if (resourceAction.error) reportError(resourceActionName.current, resourceAction.error);
  }, [resourceAction.error]);
  const saveToCatalog = async (
    name: '收藏到资源' | '保存正文快照',
    source: 'bookmark' | 'snapshot',
    payload: Parameters<typeof resourceAction.mutate>[0],
    message: string,
  ) => {
    resourceActionName.current = name;
    if (await resourceAction.mutate(payload, message))
      statusPresentationActions.hint({ key: `ui:${resourceId}:${source}`, scope, label: message, source, until: 'ack' });
  };
  const guidanceKey = `ui:${resourceId}:capture-guidance`;
  // 开始选择后采集指引不再适用。
  useEffect(() => {
    if (p?.picking) statusPresentationActions.dismissHint(guidanceKey);
  }, [p?.picking, guidanceKey]);
  const action = (action: 'navigate' | 'reload' | 'back' | 'forward' | 'pick' | 'cancelPick' | 'reattach' | 'resumeAgent', url?: string) =>
    workspaceCommand(workspaceId, {
      type: 'browserAction',
      resourceId: resource.resourceId,
      action,
      ...(url === undefined ? {} : { url }),
    });
  useLayoutEffect(() => {
    const element = host.current!;
    // 受管 App 停止/重启（非 running）期间没有原生网页可定位，此时同步布局只会被 Main 以“实例已停止”拒绝。
    // 读取最新快照而非闭包；依赖保持不变（新实例就绪时 managedAppInstanceId 变化会重新执行本效果），避免为演示/公开网页增加隐藏-显示循环。
    const pendingApp = () => {
      const space = workspaceStore.get().snapshot?.workspaces.find((w) => w.workspaceId === workspaceId);
      const latest = space?.resources.find((r) => r.resourceId === resource.resourceId);
      // 应用运行中而实例未建：布局同步正是创建原生网页的入口，不能跳过。
      return !!latest?.appProjectId && !latest.instanceId && space?.managedApp?.state !== 'running';
    };
    const sync = () => {
      if (pendingApp()) return;
      const rect = element.getBoundingClientRect();
      void workspaceCommand(workspaceId, {
        type: 'browserLayout',
        resourceId: resource.resourceId,
        layout: {
          visible: visible && !occluded,
          bounds: {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          },
        },
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      if (pendingApp()) return;
      void workspaceCommand(workspaceId, {
        type: 'browserLayout',
        resourceId: resource.resourceId,
        layout: { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } },
      });
    };
  }, [workspaceId, resource.resourceId, resource.url, managedAppInstanceId, visible, occluded]);
  const onAction = (view: StatusView) => {
    const id = view.action?.id;
    if (!id || view.action?.disabled) return;
    if (id === 'web.reload') void action('reload');
    else if (id === 'web.reattach') void action('reattach');
    else if (id === 'web.resumeAgent') void action('resumeAgent');
    else if (id === 'web.cancelPick') void cancelContextCapture(workspaceId, resource.resourceId);
  };
  // 受管 App 的合同用例按这两个 testid 定位 AI 操控条目。
  const itemTestId = (view: StatusView) =>
    view.facet === 'agent-control' ? (view.phase === 'active' ? 'agent-control-active' : 'agent-control-paused') : undefined;
  // 与窗格交互（指针、按键、焦点）后确认其中的 hint / confirmation；control / progress / problem 不受影响。
  // 原生网页区域的点击不会到达 DOM，不在此处理。
  const acknowledge = () => ackScope(scope);
  // 状态槽内的按键不算与窗格交互：槽内按钮由 Enter / 空格触发的 click 自行处理，避免按钮在 keydown 时被卸载。
  const acknowledgeKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.target as HTMLElement).closest('.status-slot')) acknowledge();
  };
  // 点击在 click 里确认（pointerdown 时确认会让槽高度变化、点击落空）；鼠标点按钮引起的焦点不算，键盘 / 文本输入的焦点才算。
  // 状态槽内的焦点不算：槽里的提示要让键盘用户先读到、再自己确认。
  const acknowledgeFocus = (event: React.FocusEvent<HTMLElement>) => {
    if (event.target.matches(':focus-visible') && !event.target.closest('.status-slot')) acknowledge();
  };
  return (
    <div className="workspace-browser" onClickCapture={acknowledge} onKeyDownCapture={acknowledgeKey} onFocusCapture={acknowledgeFocus}>
      <div className="browser-toolbar">
        <button type="button" className="icon-btn" aria-label="后退" disabled={!p?.canGoBack} onClick={() => void action('back')}>
          <Icon name="back" />
        </button>
        <button type="button" className="icon-btn" aria-label="前进" disabled={!p?.canGoForward} onClick={() => void action('forward')}>
          <Icon name="forward" />
        </button>
        <button type="button" className="icon-btn" aria-label="刷新页面" onClick={() => void action('reload')}>
          <Icon name="reload" />
        </button>
        {resource.appProjectId && appState ? (
          <span className="browser-app-status" title="沙箱应用">
            <StatusDot view={appState} />
          </span>
        ) : null}
        <form
          className="address"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (composing.current) return;
            const url = draft ?? projectedUrl;
            const version = draftVersion.current;
            if (pendingNavigation.current?.version === version && pendingNavigation.current.url === url) return;
            dirtyDraft.current = true;
            setDraft(url);
            const request = ++navigationRequest.current;
            const pending = { version, url };
            pendingNavigation.current = pending;
            void action('navigate', url).then((result) => {
              if (pendingNavigation.current === pending) pendingNavigation.current = null;
              if (!result?.ok || navigationRequest.current !== request || draftVersion.current !== version) return;
              dirtyDraft.current = false;
              setDraft(null);
              address.current?.blur();
            });
          }}
        >
          <label className="sr-only" htmlFor={`address-${resource.resourceId}`}>
            页面地址
          </label>
          <input
            ref={address}
            id={`address-${resource.resourceId}`}
            value={draft ?? projectedUrl}
            onFocus={(e) => {
              // A new focus owns its selection even before the first change event.
              draftVersion.current++;
              setDraft(e.currentTarget.value);
            }}
            onBlur={() => {
              composing.current = false;
              if (!dirtyDraft.current) setDraft(null);
            }}
            onChange={(e) => {
              draftVersion.current++;
              dirtyDraft.current = true;
              setDraft(e.target.value);
            }}
            onCompositionStart={(e) => {
              composing.current = true;
              draftVersion.current++;
              dirtyDraft.current = true;
              setDraft(e.currentTarget.value);
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (composing.current || e.nativeEvent.isComposing) {
                if (e.key === 'Enter') e.preventDefault();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                draftVersion.current++;
                dirtyDraft.current = false;
                setDraft(projectedUrl);
              }
            }}
          />
        </form>
        <button
          type="button"
          className="btn"
          aria-pressed={p?.picking ?? false}
          onClick={() => {
            if (p?.picking) {
              void cancelContextCapture(workspaceId, resource.resourceId);
            } else
              statusPresentationActions.hint({
                key: guidanceKey,
                scope,
                label: CAPTURE_GUIDANCE,
                source: 'capture-guidance',
                until: 'ack',
              });
          }}
        >
          {p?.picking ? '选择中 · Esc 取消' : '选择元素'}
        </button>
        <ToolbarPopup
          source={`browser-capture:${resourceId}`}
          role="dialog"
          label="采集到会话"
          triggerClassName="btn"
          triggerContent={
            <>
              采集到会话<span aria-hidden="true"> ⌄</span>
            </>
          }
          hidden={!visible}
          // 打开弹出层会让出原生网页，Main 会因此取消进行中的点选：选择中先取消选择。
          disabled={!!p?.picking}
          title={p?.picking ? PICKING_HINT : undefined}
        >
          {(close) => (
            <div className="browser-popup-form">
              <label>
                关联会话{' '}
                <select
                  ref={selectRef}
                  aria-label="关联会话"
                  value={associatedSessionId}
                  onChange={(e) => setAssociatedSessionId(e.target.value)}
                >
                  <option value="">明确选择会话</option>
                  {workspace?.sessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn"
                type="button"
                disabled={creatingSession}
                onClick={() => {
                  // 新建会话不需要原生网页可见：弹出层保持打开，完成后 select 已指向新会话，焦点回到 select。
                  void createAssociatedSession().then(() => selectRef.current?.focus());
                }}
              >
                新建关联会话
              </button>
              <button
                className="btn"
                type="button"
                disabled={!associatedSessionId || !resource.instanceId || !!p?.loading}
                onClick={() => {
                  // 先关闭让出遮挡：开始选择要求原生网页可见。
                  close();
                  void capture();
                }}
              >
                采集到关联会话
              </button>
              <button
                className="btn"
                type="button"
                disabled={!associatedSessionId}
                onClick={() => {
                  close();
                  void locateSession({ workspaceId, sessionId: associatedSessionId, view: 'context' });
                }}
              >
                打开关联会话
              </button>
            </div>
          )}
        </ToolbarPopup>
        <ToolbarPopup
          source={`browser-more:${resourceId}`}
          role="menu"
          label="更多网页操作"
          triggerClassName="icon-btn"
          triggerLabel="更多网页操作"
          triggerContent={<span aria-hidden="true">⋯</span>}
          hidden={!visible}
          disabled={!!p?.picking}
          title={p?.picking ? PICKING_HINT : '更多网页操作'}
        >
          {(close) =>
            resource.appProjectId ? (
              <button
                type="button"
                role="menuitem"
                disabled={!workspace}
                onClick={() => {
                  // 先回到触发器再打开对话框，对话框关闭后焦点回到这里。
                  close();
                  void spaceActions.openApp(workspaceId);
                }}
              >
                管理 App
              </button>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={resourceAction.busy}
                  onClick={() => {
                    close();
                    void saveToCatalog(
                      '收藏到资源',
                      'bookmark',
                      { type: 'bookmarkRuntimeResource', workspaceId, runtimeResourceId: resource.resourceId },
                      '已收藏到我的资源。',
                    );
                  }}
                >
                  收藏到资源
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={resourceAction.busy || !resource.instanceId || !!p?.loading || !!p?.loadError}
                  onClick={() => {
                    close();
                    void saveToCatalog(
                      '保存正文快照',
                      'snapshot',
                      { type: 'captureResourceRevision', workspaceId, runtimeResourceId: resource.resourceId },
                      '正文快照已保存；请在空间资源中明确选择参考版本。',
                    );
                  }}
                >
                  保存正文快照
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    void spaceActions.showResources(workspaceId);
                  }}
                >
                  查看空间资源
                </button>
              </>
            )
          }
        </ToolbarPopup>
      </div>
      {/* 「选择中 · Esc 取消」按钮在工具栏，槽里不重复渲染取消按钮。 */}
      <StatusSlot scope={scope} onAction={onAction} omitActions={['web.cancelPick']} itemTestId={itemTestId} />
      <div className="preview-host" ref={host} data-native={visible && !occluded ? 'visible' : 'hidden'}>
        {occluded ? (
          <p className="preview-placeholder">浮层打开期间网页已让位，关闭后恢复</p>
        ) : !resource.instanceId ? (
          <p className="preview-placeholder">{resource.unavailableReason ? '网页未在运行' : '正在恢复网页…'}</p>
        ) : null}
      </div>
    </div>
  );
}
