import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { StatusScope } from '@wsl/protocol';
import { StatusDot, StatusSlot } from '../components/Status';
import { useStore } from '../lib/store';
import { entityOf, useStatusViewByKey, type StatusView } from '../state/status-view';
import { workspaceCommand, workspaceStore, verificationLocked, panes, beginNavigation, isCurrentNavigation } from '../state/workspace';
import { spaceActions, spaceUiStore } from '../state/space-ui';
import { shellStore } from '../state/shell';
import { verificationPresentation } from './verification-presentation';
import { cancelObservationRequest } from './Observation';
import { AppImportPanel, appImportActive, type AppImportAction } from './AppImportPanel';

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
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  const verification = snapshot?.eduVerification;
  const maintenanceLocked = verificationLocked(snapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!workspaceId || !maintenanceLocked) return;
    let active = true;
    queueMicrotask(() => {
      if (active) setNow(Date.now());
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaceId, maintenanceLocked]);
  const presentation = verificationPresentation(verification, now);
  const verificationWorkspace = verification?.target?.workspaceId ?? verification?.original?.workspaceId;
  const ownVerification = verificationWorkspace === workspaceId;
  const activePane = workspace && panes(workspace.layout).find((p) => p.paneId === workspace.activePaneId);
  const activeTab = activePane && workspace?.tabs.find((t) => t.tabId === activePane.tabId);
  const student = activeTab?.targetRef.kind === 'web' && workspace?.resources.find((r) => r.resourceId === activeTab.targetRef.resourceId);
  const studentUrl = student && student.preview?.page.url;
  const canBegin =
    snapshot?.activeWorkspaceId === workspaceId &&
    !!studentUrl &&
    new URL(studentUrl).pathname === '/student' &&
    student.appProjectId === workspace?.managedApp?.projectId &&
    !!student.instanceId &&
    !snapshot.workspaces.some((w) => ['starting', 'stopping'].includes(w.managedApp?.state ?? ''));
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogSession = useRef(0);
  const openingPage = useRef<string | null>(null);
  const [openingPageFor, setOpeningPageFor] = useState<string | null>(null);
  const busy = useRef(new Set<string>());
  const [operations, setOperations] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const pending = workspaceId ? (operations[workspaceId]?.at(-1) ?? null) : null;
  const error = workspaceId ? errors[workspaceId] : null;
  useEffect(() => {
    dialogSession.current++;
    if (workspaceId) dialog.current?.showModal();
    else dialog.current?.close();
  }, [workspaceId]);
  const app = workspace?.managedApp;
  const appImport = !app || workspace?.appImport?.projectId === app.projectId ? workspace?.appImport : null;
  const importing = appImportActive(appImport);
  const edu = app?.profile?.projectKind === 'edu-web' ? app.profile : null;
  const mota = app?.profile?.projectKind === 'mota-web' ? app.profile : null;
  const profileLabel = edu ? 'edu-web / profile v1 · Python 3.12 + React' : mota ? '魔塔游戏 / profile v1 · Node' : '沙箱 React 全栈工程';
  const close = () => {
    // Page navigation has already been dispatched; wait for its result before dismissing.
    // Import, copy and start remain dismissible and continue in the background.
    if (openingPage.current === workspaceId) return;
    dialogSession.current++;
    spaceActions.closeApp();
  };
  const act = async (
    action:
      | {
          type:
            'createApp' | 'startApp' | 'stopApp' | 'exportApp' | 'beginEduVerification' | 'endEduVerification' | 'reconcileEduVerification';
        }
      | { type: 'openAppPage'; page: 'admin' | 'student' | 'game' | 'editor' }
      | AppImportAction,
  ) => {
    if (!workspaceId) return;
    const { type } = action;
    const targetId = workspaceId;
    const key = `${targetId}:${type}`;
    const active = [...busy.current].filter((item) => item.startsWith(`${targetId}:`));
    if (busy.current.has(key) || (!['stopApp', 'endEduVerification', 'cancelAppImport'].includes(type) && active.length)) return;
    const session = dialogSession.current;
    const navigation = beginNavigation();
    const currentDialog = () =>
      session === dialogSession.current &&
      !!dialog.current?.open &&
      spaceUiStore.get().appWorkspaceId === targetId &&
      workspaceStore.get().selectedId === targetId &&
      shellStore.get().route === 'space' &&
      isCurrentNavigation(navigation);
    const showPage = async (page: 'admin' | 'student' | 'game' | 'editor') => {
      openingPage.current = targetId;
      setOpeningPageFor(targetId);
      try {
        const result = await workspaceCommand(targetId, { type: 'openAppPage', page });
        if (!result?.ok) setErrors((s) => ({ ...s, [targetId]: result ? result.error.message : '打开页面失败，请重试。' }));
        else if (currentDialog()) {
          dialogSession.current++;
          spaceActions.closeApp();
        }
      } finally {
        if (openingPage.current === targetId) {
          openingPage.current = null;
          setOpeningPageFor(null);
        }
      }
    };
    busy.current.add(key);
    setOperations((s) => ({ ...s, [targetId]: [...(s[targetId] ?? []), type] }));
    setErrors((s) => ({ ...s, [targetId]: null }));
    try {
      if (action.type === 'openAppPage') {
        await showPage(action.page);
        return;
      }
      const result = await workspaceCommand(targetId, action);
      const importCancelled =
        typeIsImport(type) && result?.snapshot.workspaces.find((value) => value.workspaceId === targetId)?.appImport?.phase === 'cancelled';
      if (!result?.ok && !importCancelled)
        setErrors((s) => ({ ...s, [targetId]: result ? result.error.message : (workspaceStore.get().error ?? '操作失败，请重试。') }));
      else if (type === 'beginEduVerification' && currentDialog()) close();
      else if (result?.ok && (action.type === 'confirmAppImport' || action.type === 'retryAppImport')) {
        const imported = result.snapshot.workspaces.find((value) => value.workspaceId === targetId);
        if (
          imported?.appImport?.previewId === action.previewId &&
          imported.appImport.phase === 'completed' &&
          imported.managedApp?.projectId === imported.appImport.projectId &&
          imported.managedApp?.state === 'running' &&
          currentDialog()
        ) {
          if (imported.managedApp.profile?.projectKind === 'mota-web') await showPage('game');
          else if (imported.managedApp.profile?.projectKind === 'edu-web') await showPage('student');
        }
      }
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
        close();
      }}
    >
      <div className="managed-app-content">
        <div className="row space-between gap-8">
          <h2>{app ? '管理 App' : '新建 App'}</h2>
          <button type="button" className="btn" autoFocus disabled={openingPageFor === workspaceId} onClick={close}>
            关闭
          </button>
        </div>
        {/* 空间名与工程类型是不变量说明，不是状态：悬停与视觉隐藏文本，对话框描述引用它。 */}
        {workspace ? (
          <span id={noteId} className="sr-only">
            {workspace.name} · {profileLabel}
          </span>
        ) : null}
        {appImport && appImport.phase !== 'completed' ? (
          <AppImportPanel
            view={appImport}
            pending={pending}
            locked={maintenanceLocked}
            cleanupConfirmed={!!app?.cleanupConfirmed}
            canRestart={idle}
            onAction={(action) => void act(action)}
          />
        ) : null}
        {workspace?.app ? (
          <>
            <p title={[`${workspace.name} · ${profileLabel}`, app?.guestCwd].filter(Boolean).join('\n')}>
              <strong>{workspace.app.name}</strong>
            </p>
            {workspace.app.description ? <p className="muted small">{workspace.app.description}</p> : null}
            <button
              type="button"
              className="btn"
              disabled={!!pending || importing}
              onClick={() => {
                close();
                void spaceActions.openAppEditor(workspace);
              }}
            >
              编辑 App
            </button>
          </>
        ) : null}
        {(edu && !importing) || maintenanceLocked ? (
          <section aria-label="发音验证">
            <p role="status" aria-live="polite">
              {presentation.label}
            </p>
            <p className="muted small">有效期 5 分钟，最多 2 次评分。退出并确认默认模式恢复后，才可继续编码、终端和重建。</p>
            {verification?.status && ownVerification && maintenanceLocked ? (
              <p>
                剩余 {presentation.remainingCalls} / 2 次 · 剩余 {Math.floor((presentation.remainingSeconds ?? 0) / 60)} 分{' '}
                {(presentation.remainingSeconds ?? 0) % 60} 秒
              </p>
            ) : null}
            {maintenanceLocked && !ownVerification ? <p className="muted small">另一空间的验证尚未结束；全部空间暂停维护。</p> : null}
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              {edu ? (
                <button
                  type="button"
                  className="btn"
                  disabled={maintenanceLocked || !!pending || app?.state !== 'running' || !canBegin}
                  onClick={() => void act({ type: 'beginEduVerification' })}
                >
                  开始发音验证
                </button>
              ) : null}
              {ownVerification && !verification?.recoveryRequired ? (
                <button
                  type="button"
                  className="btn"
                  disabled={!presentation.canEnd || pending === 'endEduVerification'}
                  onClick={() => void act({ type: 'endEduVerification' })}
                >
                  退出验证并恢复维护
                </button>
              ) : null}
              {verification?.recoveryRequired ? (
                <button
                  type="button"
                  className="btn"
                  disabled={!presentation.canReconcile || !!pending}
                  onClick={() => void act({ type: 'reconcileEduVerification' })}
                >
                  核对并恢复维护
                </button>
              ) : null}
            </div>
            {edu && !maintenanceLocked && !canBegin ? <p className="muted small">先打开当前应用的学生页，再开始发音验证。</p> : null}
          </section>
        ) : null}
        {app && workspace ? (
          <>
            <AppServiceStatus workspaceId={workspace.workspaceId} guestCwd={app.guestCwd} />
            {mota ? (
              <>
                <details className="small" style={{ overflowWrap: 'anywhere' }}>
                  <summary>导入来源与源码基线</summary>
                  <p>所选目录的静态源码与游戏素材 · {mota.source.files.length} 个文件</p>
                  <p>
                    基线 SHA256：<code>{mota.source.sourceSha256}</code>
                  </p>
                </details>
                <p className="muted small">本版支持手动编辑 MT1 地图与编辑器配置，保存到隔离副本。暂不支持 AI 任务和源码导出。</p>
                <div className="row gap-8">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={app.state !== 'running' || maintenanceLocked || !!pending || importing}
                    onClick={() => void act({ type: 'openAppPage', page: 'game' })}
                  >
                    游戏页面
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={app.state !== 'running' || maintenanceLocked || !!pending || importing}
                    onClick={() => void act({ type: 'openAppPage', page: 'editor' })}
                  >
                    地图编辑器
                  </button>
                </div>
              </>
            ) : null}
            {edu ? (
              <>
                <details className="small" style={{ overflowWrap: 'anywhere' }}>
                  <summary>导入来源与源码基线</summary>
                  <p>
                    Git 提交：<code>{edu.source.repository.commit}</code>
                  </p>
                  <p>
                    来源状态：{edu.source.repository.dirty ? '包含未提交修改' : '干净提交'} · {edu.source.files.length} 个源码文件
                  </p>
                  <p>
                    基线 SHA256：<code>{edu.source.sourceSha256}</code>
                  </p>
                  {app.sourceSha256 ? (
                    <p>
                      App 源码 SHA256：<code>{app.sourceSha256}</code>
                    </p>
                  ) : null}
                </details>
                <p className="muted small">
                  允许修改 admin/src；后端和锁文件变化需显式重新导入。默认维护模式关闭评分；录音仅限当前学生页。
                </p>
                <div className="row gap-8">
                  <button
                    type="button"
                    className="btn"
                    disabled={app.state !== 'running' || !!pending || importing}
                    onClick={() => void act({ type: 'openAppPage', page: 'admin' })}
                  >
                    管理员页
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={app.state !== 'running' || !!pending || importing}
                    onClick={() => void act({ type: 'openAppPage', page: 'student' })}
                  >
                    学生页
                  </button>
                </div>
              </>
            ) : null}
            {!importing ? (
              <div className="row gap-8">
                {!appImport?.canRetry ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={maintenanceLocked || !idle || !!pending || importing}
                    onClick={() => void act({ type: 'startApp' })}
                  >
                    启动应用
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  disabled={
                    !['starting', 'running', 'failed'].includes(app.state) ||
                    importing ||
                    (workspaceId !== null && operations[workspaceId]?.includes('stopApp')) ||
                    (!!pending && pending !== 'startApp')
                  }
                  onClick={() => void act({ type: 'stopApp' })}
                >
                  {app.state === 'starting' ? '取消启动' : '停止应用'}
                </button>
                {!mota ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={!idle || !!pending || importing}
                    onClick={() => void act({ type: 'exportApp' })}
                  >
                    导出源码
                  </button>
                ) : null}
              </div>
            ) : null}
            {app.state === 'failed' && app.error ? (
              <details className="managed-app-error">
                <summary>错误详情</summary>
                <pre>{app.error}</pre>
              </details>
            ) : null}
            {workspace?.appExport && !mota ? (
              <p className="muted small" style={{ overflowWrap: 'anywhere' }}>
                源码已导出：{workspace.appExport.path}
                <br />
                SHA256：{workspace.appExport.sha256}
                {workspace.appExport.manifestPath ? (
                  <>
                    <br />
                    清单：{workspace.appExport.manifestPath}
                  </>
                ) : null}
                {edu ? (
                  <>
                    <br />
                    来源类型：workbench-export；导出不包含数据库、依赖、环境文件和构建缓存。
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        ) : !appImport || appImport.phase === 'cancelled' ? (
          <>
            <p>创建工程后，可在这里启动、停止应用或导出源码。</p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={maintenanceLocked || !!pending || importing || !workspace}
              onClick={() => {
                if (workspace) {
                  close();
                  void spaceActions.openAppEditor(workspace);
                }
              }}
            >
              创建标准应用
            </button>
            <button
              type="button"
              className="btn"
              disabled={maintenanceLocked || !!pending || importing || !workspace}
              onClick={() => void act({ type: 'previewAppImport' })}
            >
              导入已有工程
            </button>
            <p className="muted small">
              支持 edu Git 工程与魔塔工程。先检查源码和素材，再确认导入独立沙箱；原目录保持不变，不导入凭据与账号数据。
            </p>
          </>
        ) : null}
        {openingPageFor === workspaceId ? (
          <p role="status">正在打开页面…</p>
        ) : pending && !typeIsImport(pending) ? (
          <p role="status">{pending === 'exportApp' ? '正在导出源码…' : '正在处理…'}</p>
        ) : null}
        {error && error !== appImport?.error?.message ? <p role="alert">{error}</p> : null}
      </div>
    </dialog>
  );
}

function typeIsImport(type: string): boolean {
  return ['previewAppImport', 'confirmAppImport', 'cancelAppImport', 'retryAppImport'].includes(type);
}
