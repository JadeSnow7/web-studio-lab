import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { StatusScope } from '@wsl/protocol';
import { StatusDot, StatusSlot } from '../components/Status';
import { useStore } from '../lib/store';
import { entityOf, useStatusViewByKey, type StatusView } from '../state/status-view';
import { workspaceCommand, workspaceStore } from '../state/workspace';
import { spaceActions } from '../state/space-ui';
import { cancelObservationRequest } from './Observation';

/** 对话框里「启动应用」「停止应用」「编辑 App」按钮已存在，状态槽不再重复渲染同名动作。 */
const SLOT_OMIT_ACTIONS = ['app.start', 'app.manage', 'app.create'] as const;

/**
 * 服务状态：状态文案与动作来自事实层 app:<ws>:state / :cleanup，组件不自行映射。
 * 稳态（已创建 / 运行中 / 已停止）是一行 StatusDot + 可见 label；启动中 / 停止中（常驻）、运行失败（问题）与
 * 「停止后的清理未确认」（常驻）由对话框内的状态槽承载，不再重复画一行。
 * 沙箱目录属于元数据：悬停与视觉隐藏文本，不常驻外露。
 */
function AppServiceStatus({ workspaceId, guestCwd }: { workspaceId: string; guestCwd: string }) {
  const scope = useMemo<StatusScope>(() => ({ kind: 'workspace', workspaceId }), [workspaceId]);
  const state = useStatusViewByKey(scope, `app:${workspaceId}:state`);
  const onAction = (view: StatusView) => {
    if (view.action?.id === 'observation.cancel' && !view.action.disabled) void cancelObservationRequest(workspaceId, null, entityOf(view));
  };
  return (
    <>
      {state?.channel === 'ambient' ? (
        <p role="status">
          <StatusDot view={state} visibleLabel title={guestCwd ? `${state.label}（${guestCwd}）` : undefined} />
        </p>
      ) : null}
      <StatusSlot scope={scope} onAction={onAction} omitActions={SLOT_OMIT_ACTIONS} />
      {guestCwd ? <span className="sr-only">{guestCwd}</span> : null}
    </>
  );
}

export function ManagedAppDialog({ workspaceId }: { workspaceId: string | null }) {
  const workspace = useStore(workspaceStore, (s) => s.snapshot?.workspaces.find((w) => w.workspaceId === workspaceId));
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(new Set<string>());
  const [operations, setOperations] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const pending = workspaceId ? (operations[workspaceId]?.at(-1) ?? null) : null;
  const error = workspaceId ? errors[workspaceId] : null;
  useEffect(() => {
    if (workspaceId) dialog.current?.showModal();
    else dialog.current?.close();
  }, [workspaceId]);
  const app = workspace?.managedApp;
  const act = async (type: 'startApp' | 'stopApp' | 'exportApp') => {
    if (!workspaceId) return;
    const targetId = workspaceId;
    const key = `${targetId}:${type}`;
    const active = [...busy.current].filter((item) => item.startsWith(`${targetId}:`));
    if (busy.current.has(key) || (type !== 'stopApp' && active.length)) return;
    busy.current.add(key);
    setOperations((s) => ({ ...s, [targetId]: [...(s[targetId] ?? []), type] }));
    setErrors((s) => ({ ...s, [targetId]: null }));
    try {
      const result = await workspaceCommand(targetId, { type });
      if (!result?.ok)
        setErrors((s) => ({ ...s, [targetId]: result ? result.error.message : (workspaceStore.get().error ?? '操作失败，请重试。') }));
    } finally {
      busy.current.delete(key);
      setOperations((s) => ({ ...s, [targetId]: (s[targetId] ?? []).filter((item) => item !== type) }));
    }
  };
  const noteId = useId();
  const idle = !!app?.cleanupConfirmed && !['starting', 'running', 'stopping'].includes(app.state);
  return (
    <dialog
      ref={dialog}
      className="workspace-editor managed-app-dialog"
      aria-label="空间 App"
      aria-describedby={workspace ? noteId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        spaceActions.closeApp();
      }}
    >
      <div className="managed-app-content">
        <div className="row space-between gap-8">
          <h2>{app ? '管理 App' : '新建 App'}</h2>
          <button type="button" className="btn" autoFocus onClick={spaceActions.closeApp}>
            关闭
          </button>
        </div>
        {/* 空间名与工程类型是不变量说明，不是状态：悬停与视觉隐藏文本，对话框描述引用它。 */}
        {workspace ? (
          <span id={noteId} className="sr-only">
            {workspace.name} · 沙箱 React 全栈工程
          </span>
        ) : null}
        {workspace?.app ? (
          <>
            <p title={[`${workspace.name} · 沙箱 React 全栈工程`, app?.guestCwd].filter(Boolean).join('\n')}>
              <strong>{workspace.app.name}</strong>
            </p>
            {workspace.app.description ? <p className="muted small">{workspace.app.description}</p> : null}
            <button
              type="button"
              className="btn"
              disabled={!!pending}
              onClick={() => {
                spaceActions.closeApp();
                void spaceActions.openAppEditor(workspace);
              }}
            >
              编辑 App
            </button>
          </>
        ) : null}
        {app && workspace ? (
          <>
            <AppServiceStatus workspaceId={workspace.workspaceId} guestCwd={app.guestCwd} />
            <div className="row gap-8">
              <button type="button" className="btn btn-primary" disabled={!idle || !!pending} onClick={() => void act('startApp')}>
                启动应用
              </button>
              <button
                type="button"
                className="btn"
                disabled={
                  !['starting', 'running', 'failed'].includes(app.state) ||
                  (workspaceId !== null && operations[workspaceId]?.includes('stopApp')) ||
                  (!!pending && pending !== 'startApp')
                }
                onClick={() => void act('stopApp')}
              >
                {app.state === 'starting' ? '取消启动' : '停止应用'}
              </button>
              <button type="button" className="btn" disabled={!idle || !!pending} onClick={() => void act('exportApp')}>
                导出源码
              </button>
            </div>
            {app.state === 'failed' && app.error ? (
              <details className="managed-app-error">
                <summary>错误详情</summary>
                <pre>{app.error}</pre>
              </details>
            ) : null}
            {workspace?.appExport ? (
              <p className="muted small">
                源码已导出：{workspace.appExport.path}
                <br />
                SHA256：{workspace.appExport.sha256}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p>创建工程后，可在这里启动、停止应用或导出源码。</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!pending || !workspace}
              onClick={() => {
                if (workspace) {
                  spaceActions.closeApp();
                  void spaceActions.openAppEditor(workspace);
                }
              }}
            >
              创建标准应用
            </button>
          </>
        )}
        {pending ? <p role="status">{pending === 'exportApp' ? '正在导出源码…' : '正在处理…'}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </dialog>
  );
}
