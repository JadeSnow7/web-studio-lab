import { shortcutModalOpen, webAddressFocusStore, completeNewWebAddressFocus } from '../state/shortcuts';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StatusScope, WorkbenchResource } from '@wsl/protocol';
import { workspaceCommand, workspaceStore } from '../state/workspace';
import { useStore } from '../lib/store';
import { cancelCapture, createReceiverSession, toggleCapture, useCaptureState } from '../state/capture';
import { receiverActions, resolveDefaultReceiver, useReceiverPreferences } from '../state/capture-receiver';
import { locateSession } from '../state/location';
import { Icon } from '../components/Icon';
import { StatusDot, StatusSlot } from '../components/Status';
import { spaceActions } from '../state/space-ui';
import { useCatalogMutation } from '../state/catalog';
import { reportError } from '../state/errors';
import {
  captureReceiverMenuEffect,
  menuAnchorFromClick,
  menuView,
  nativeMenuKey,
  openNativeMenu,
  useNativeMenuExpanded,
  webMoreMenuEffect,
} from '../state/native-menu';
import { ackScope, statusPresentationActions, useStatusViewByKey, type StatusView } from '../state/status-view';

import { browserAddress } from './browser-address';

const PICKING_HINT = '选择中，先取消选择';
const SAVING_HINT = '正在保存，完成后可再操作';
const CREATING_SESSION_HINT = '正在新建会话，完成后可再操作';

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
  const nativeLayoutSync = useRef<(() => void) | null>(null);
  const addressFocusIntent = useStore(webAddressFocusStore, (state) =>
    state.intent?.workspaceId === workspaceId && state.intent.resourceId === resource.resourceId ? state.intent : null,
  );
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
  // 默认接收者（OPS-1 S1）：显式选择 > 进行中请求冻结的接收者 > 同屏最近活动 > 本空间最近活动 > 发起时自动新建；开始采集前就显示在按钮上。
  const { explicit, activity } = useReceiverPreferences(workspaceId, resource.resourceId);
  const { starting, pendingSessionId } = useCaptureState(workspaceId, resource.resourceId);
  const receiver = workspace
    ? resolveDefaultReceiver({ workspace, resourceId: resource.resourceId, explicitSessionId: explicit, pendingSessionId, activity })
    : null;
  const pendingTitle = pendingSessionId ? workspace?.sessions.find((s) => s.sessionId === pendingSessionId)?.title : undefined;
  const captureExpanded = useNativeMenuExpanded(
    nativeMenuKey('capture-receiver', { workspaceId, resourceId: resource.resourceId, receiverSessionId: null }),
  );
  const moreExpanded = useNativeMenuExpanded(nativeMenuKey('web-more', { workspaceId, resourceId: resource.resourceId }));
  const creating = useRef(false);
  // 新建会话进行中禁用接收者按钮，第二次选择不会被静默丢弃。
  const [creatingSession, setCreatingSession] = useState(false);
  /** 接收者菜单「新建会话」：新建不占用窗格的会话并设为之后采集的接收者，不开始采集。 */
  const chooseNewSession = async (targetWorkspaceId: string, targetResourceId: string) => {
    if (creating.current) return;
    creating.current = true;
    setCreatingSession(true);
    try {
      const sessionId = await createReceiverSession(targetWorkspaceId, targetResourceId);
      if (sessionId) receiverActions.choose(targetWorkspaceId, targetResourceId, sessionId);
    } catch (error) {
      reportError('新建会话', error);
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
  // 「选择元素」一步发起采集（OPS-1 S1）；进行中再次触发即取消。失败登记为界面错误，不静默吞掉。
  const toggle = () => toggleCapture(workspaceId, resourceId).catch((error: unknown) => reportError('选择元素', error));
  const cancelPick = () => cancelCapture(workspaceId, resourceId).catch((error: unknown) => reportError('取消采集', error));
  const picking = !!p?.picking || starting;
  const capturable = !!resource.instanceId && !p?.loading;
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
      const layout = workspaceCommand(workspaceId, {
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
      if (visible && !occluded)
        void layout
          .then((result) => completeNewWebAddressFocus(workspaceId, resource.resourceId, result?.ok === true))
          .catch((error: unknown) => reportError('聚焦新网页地址', error));
    };
    nativeLayoutSync.current = sync;
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener('resize', sync);
    return () => {
      nativeLayoutSync.current = null;
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
  useLayoutEffect(() => {
    if (addressFocusIntent && visible && !occluded) nativeLayoutSync.current?.();
  }, [addressFocusIntent, visible, occluded, p?.page.documentGeneration, p?.loading, p?.loadError]);
  const onAction = (view: StatusView) => {
    const id = view.action?.id;
    if (!id || view.action?.disabled) return;
    if (id === 'web.reload') void action('reload');
    else if (id === 'web.reattach') void action('reattach');
    else if (id === 'web.resumeAgent') void action('resumeAgent');
    else if (id === 'web.cancelPick') void cancelPick();
    else if (id === 'session.open' && view.locate) {
      // 「已采集到 {会话} · 打开」：定位登记时冻结的接收会话（打开对话视图，不跳到「上下文」）。
      statusPresentationActions.dismissHint(view.key);
      void locateSession({ workspaceId: view.locate.workspaceId, sessionId: view.locate.sessionId, view: 'conversation' });
    }
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
    <div
      className="workspace-browser"
      onClickCapture={(event) => {
        // 槽内动作必须先执行；提前确认会卸载提示，使点击 / Enter 的动作丢失。
        if (!(event.target as HTMLElement).closest('.status-slot')) acknowledge();
      }}
      onKeyDownCapture={acknowledgeKey}
      onFocusCapture={acknowledgeFocus}
      onKeyDown={(event) => {
        // 焦点在工具栏（而不是原生网页）时，Esc 同样取消点选；地址栏与 IME 组词各自处理 Esc。
        if (event.key !== 'Escape' || event.defaultPrevented || shortcutModalOpen() || event.nativeEvent.isComposing || !p?.picking) return;
        event.preventDefault();
        void cancelPick();
      }}
    >
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
            const url = browserAddress(draft ?? projectedUrl);
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
          {(draft ?? projectedUrl) && (
            <button
              type="button"
              className="icon-btn"
              aria-label="清空地址"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                draftVersion.current++;
                dirtyDraft.current = true;
                setDraft('');
                address.current?.focus();
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </form>
        {/* 不能开始点选时用 aria-disabled（仍可聚焦，悬停与可访问描述说明原因），点击不做任何事。 */}
        <button
          type="button"
          className="btn"
          aria-pressed={picking}
          aria-busy={starting || undefined}
          aria-disabled={!picking && !capturable ? true : undefined}
          title={!picking && !capturable ? (resource.instanceId ? '网页加载中，完成后可选择元素' : '网页未在运行') : undefined}
          onClick={(event) => {
            // 双击的第二下不算第二次触发（O03d）：连点只发起一次，不会紧接着取消。
            if (event.detail > 1 || (!picking && !capturable)) return;
            void toggle();
          }}
        >
          {starting ? '正在准备点选…' : picking ? '选择中 · Esc 取消' : '选择元素'}
        </button>
        {/* 接收者按钮（OPS-1 S1）：显示默认接收会话，原生菜单（不进入遮挡集合）可改为本空间其他会话、新建会话或打开接收会话；只影响之后的采集。 */}
        <button
          type="button"
          className="btn browser-receiver"
          aria-label={
            receiver ? (receiver.sessionId ? `接收会话：${receiver.title}` : `接收会话：将自动新建「${receiver.title}」`) : '接收会话'
          }
          aria-haspopup="menu"
          aria-expanded={captureExpanded}
          disabled={creatingSession || !receiver}
          title={
            creatingSession
              ? CREATING_SESSION_HINT
              : pendingTitle && receiver?.sessionId !== pendingSessionId
                ? `本次采集保存到「${pendingTitle}」；之后的采集保存到「${receiver?.title ?? ''}」`
                : '选择采集结果保存到哪个会话'
          }
          onClick={async (event) => {
            const choice = await openNativeMenu('capture-receiver', {
              workspaceId,
              resourceId,
              receiverSessionId: receiver?.sessionId ?? null,
              anchor: menuAnchorFromClick(event, event.currentTarget),
            });
            if (choice?.menuId !== 'capture-receiver') return;
            const effect = captureReceiverMenuEffect(choice, menuView());
            if (!effect) return;
            if (effect.kind === 'choose') receiverActions.choose(effect.workspaceId, effect.resourceId, effect.sessionId);
            else if (effect.kind === 'create') void chooseNewSession(effect.workspaceId, effect.resourceId);
            else void locateSession({ workspaceId: effect.workspaceId, sessionId: effect.sessionId, view: 'conversation' });
          }}
        >
          <span aria-hidden="true">→ {receiver?.sessionId ? receiver.title : '新建会话'} ⌄</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="更多网页操作"
          title={p?.picking ? PICKING_HINT : resourceAction.busy ? SAVING_HINT : '更多网页操作'}
          aria-haspopup="menu"
          aria-expanded={moreExpanded}
          // 收藏 / 正文快照保存进行中禁用（与原菜单项的忙态一致），第二次选择不会被静默丢弃。
          disabled={!!p?.picking || resourceAction.busy}
          onClick={async (event) => {
            const choice = await openNativeMenu('web-more', {
              workspaceId,
              resourceId,
              anchor: menuAnchorFromClick(event, event.currentTarget),
            });
            if (choice?.menuId !== 'web-more') return;
            const effect = webMoreMenuEffect(choice, menuView());
            if (!effect) return;
            if (effect.kind === 'catalog') {
              if (effect.action === 'bookmark') void saveToCatalog('收藏到资源', 'bookmark', effect.payload, '已收藏到我的资源。');
              else void saveToCatalog('保存正文快照', 'snapshot', effect.payload, '正文快照已保存；请在空间资源中明确选择参考版本。');
            } else if (effect.kind === 'manage-app') void spaceActions.openApp(effect.workspaceId);
            else void spaceActions.showResources(effect.workspaceId);
          }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
      {/* 「选择中 · Esc 取消」按钮在工具栏，槽里不重复渲染取消按钮；「已采集到 {会话} · 打开」在提示通道。 */}
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
