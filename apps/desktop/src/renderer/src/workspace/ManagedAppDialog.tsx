import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { workspaceCommand, workspaceStore } from '../state/workspace';
import { spaceActions } from '../state/space-ui';

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
  const idle = !!app?.cleanupConfirmed && !['starting', 'running', 'stopping'].includes(app.state);
  return (
    <dialog
      ref={dialog}
      className="workspace-editor managed-app-dialog"
      aria-label="空间 App"
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
        <p className="muted small">{workspace?.name} · 沙箱 React 全栈工程</p>
        {workspace?.app ? (
          <>
            <p>{workspace.app.name}</p>
            <p className="muted small">{workspace.app.description || '暂无 App 说明'}</p>
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
        {app ? (
          <>
            <p role="status">
              {
                {
                  created: '已创建',
                  starting: '正在准备应用…',
                  running: '运行中',
                  stopping: '正在停止…',
                  stopped: '已停止',
                  failed: '操作失败',
                }[app.state]
              }
            </p>
            <p className="muted small">{app.guestCwd}</p>
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
            {app.error ? <p role="alert">{app.error}</p> : null}
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
