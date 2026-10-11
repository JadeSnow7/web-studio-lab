import { useLayoutEffect, useRef, useState } from 'react';
import type { WorkbenchResource } from '@wsl/protocol';
import { workspaceCommand, workspaceStore } from '../state/workspace';
import { useStore } from '../lib/store';
import { captureContext, cancelContextCapture } from '../state/capture';
import { locateSession } from '../state/location';
import { Icon } from '../components/Icon';
import { spaceActions } from '../state/space-ui';
import { useCatalogMutation } from '../state/catalog';

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
  const composing = useRef(false);
  const draftVersion = useRef(0);
  const navigationRequest = useRef(0);
  const pendingNavigation = useRef<{ version: number; url: string } | null>(null);
  const p = resource.preview;
  const workspace = useStore(workspaceStore, (s) => s.snapshot?.workspaces.find((w) => w.workspaceId === workspaceId));
  const managedAppInstanceId = resource.appProjectId ? workspace?.managedApp?.appInstanceId : null;
  const [associatedSessionId, setAssociatedSessionId] = useState('');
  const capture = () => captureContext(workspaceId, associatedSessionId, resource.resourceId);
  const [creatingSession, setCreatingSession] = useState(false);
  const creating = useRef(false);
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
  const resourceAction = useCatalogMutation();
  const [captureGuidance, setCaptureGuidance] = useState(false);
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
  return (
    <div className="workspace-browser">
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
        <form
          className="address"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (composing.current) return;
            const url = draft ?? p?.page.url ?? '';
            const version = draftVersion.current;
            if (pendingNavigation.current?.version === version && pendingNavigation.current.url === url) return;
            const request = ++navigationRequest.current;
            const pending = { version, url };
            pendingNavigation.current = pending;
            void action('navigate', url).then((result) => {
              if (pendingNavigation.current === pending) pendingNavigation.current = null;
              if (!result?.ok || navigationRequest.current !== request || draftVersion.current !== version) return;
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
            value={draft ?? p?.page.url ?? resource.url ?? ''}
            onChange={(e) => {
              draftVersion.current++;
              setDraft(e.target.value);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                draftVersion.current++;
                setDraft(null);
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
            } else setCaptureGuidance(true);
          }}
        >
          {p?.picking ? '选择中 · Esc 取消' : '选择元素'}
        </button>
      </div>
      <div className="resource-browser-actions row wrap gap-8">
        <label>
          关联会话{' '}
          <select aria-label="关联会话" value={associatedSessionId} onChange={(e) => setAssociatedSessionId(e.target.value)}>
            <option value="">明确选择会话</option>
            {workspace?.sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" disabled={creatingSession} onClick={() => void createAssociatedSession()}>
          新建关联会话
        </button>
        <button
          className="btn"
          type="button"
          disabled={!associatedSessionId || !resource.instanceId || !!p?.loading}
          onClick={() => void capture()}
        >
          采集到关联会话
        </button>
        <button
          className="btn"
          type="button"
          disabled={!associatedSessionId}
          onClick={() => void locateSession({ workspaceId, sessionId: associatedSessionId, view: 'context' })}
        >
          打开关联会话
        </button>
      </div>
      {captureGuidance && !p?.picking ? (
        <p className="workspace-inline-info" role="status">
          请在此网页的“关联会话”中明确选择会话，再点击“采集到关联会话”。没有会话时可新建关联会话；采集结果保存在所选会话。
        </p>
      ) : null}
      {resource.appProjectId ? (
        <>
          <p className="resource-browser-actions muted small" role="status">
            沙箱应用 · {workspace?.managedApp?.state === 'running' ? '服务运行中' : '服务未运行'}
          </p>
          {p?.agentControl?.state === 'active' ? (
            <p className="workspace-inline-info" role="status" data-testid="agent-control-active">
              AI 正在操控此页面（{p.agentControl.lastAction ?? '操作'}）。你在页面中点击或输入会立即暂停 AI。
            </p>
          ) : p?.agentControl?.state === 'paused_by_user' ? (
            <p className="workspace-inline-info" role="status" data-testid="agent-control-paused">
              已暂停 AI 操控：检测到你在页面中的操作。{' '}
              <button type="button" className="btn" onClick={() => void action('resumeAgent')}>
                允许 AI 继续
              </button>
            </p>
          ) : null}
        </>
      ) : (
        <div className="resource-browser-actions row wrap gap-8">
          <span className="muted small">收藏地址与正文快照分别保存</span>
          <button
            type="button"
            className="btn"
            disabled={resourceAction.busy}
            onClick={() =>
              void resourceAction.mutate(
                { type: 'bookmarkRuntimeResource', workspaceId, runtimeResourceId: resource.resourceId },
                '已收藏到我的资源。',
              )
            }
          >
            收藏到资源
          </button>
          <button
            type="button"
            className="btn"
            disabled={resourceAction.busy || !resource.instanceId || !!p?.loading || !!p?.loadError}
            onClick={() =>
              void resourceAction.mutate(
                { type: 'captureResourceRevision', workspaceId, runtimeResourceId: resource.resourceId },
                '正文快照已保存；请在空间资源中明确选择参考版本。',
              )
            }
          >
            保存正文快照
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => spaceActions.showResources(workspaceId)}>
            查看空间资源
          </button>
        </div>
      )}
      {resourceAction.error ? (
        <p className="workspace-inline-error" role="alert">
          {resourceAction.error}
        </p>
      ) : null}
      {resourceAction.notice ? (
        <p className="workspace-inline-info" role="status">
          {resourceAction.notice}
        </p>
      ) : null}
      {p?.pickError ? (
        <p className="workspace-inline-error" role="alert">
          {p.pickError}
        </p>
      ) : null}
      {p?.loadError ? (
        <p className="workspace-inline-error" role="alert">
          页面加载失败：{p.loadError.description}
        </p>
      ) : null}
      {p?.blockedNavigation ? <p role="alert">已拦截导航：{p.blockedNavigation}</p> : null}
      {p?.cdp.state === 'detached' ? (
        <p role="status">
          页面控制已断开{' '}
          <button type="button" className="btn" onClick={() => void action('reattach')}>
            重新附着
          </button>
        </p>
      ) : null}
      <div className="preview-host" ref={host} data-native={visible && !occluded ? 'visible' : 'hidden'}>
        {occluded ? (
          <p className="preview-placeholder">浮层打开期间网页已让位，关闭后恢复</p>
        ) : !resource.instanceId ? (
          <p className="preview-placeholder">{resource.unavailableReason ?? '正在恢复网页…'}</p>
        ) : null}
      </div>
    </div>
  );
}
