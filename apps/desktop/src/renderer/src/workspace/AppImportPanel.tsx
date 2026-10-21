import type { WorkbenchCommand, WorkspaceSnapshot } from '@wsl/protocol';

type ImportView = NonNullable<WorkspaceSnapshot['appImport']>;
type CommandPayload<C> = C extends WorkbenchCommand ? Omit<C, 'commandId' | 'workspaceId' | 'expectedRevision'> : never;
export type AppImportAction = CommandPayload<
  Extract<WorkbenchCommand, { type: 'previewAppImport' | 'confirmAppImport' | 'cancelAppImport' | 'retryAppImport' }>
>;

export function appImportActive(view: ImportView | null | undefined): boolean {
  return !!view && !['cancelled', 'failed', 'completed'].includes(view.phase);
}

const stages: Record<ImportView['phase'], string> = {
  selecting: '请选择 edu Git 工程或魔塔工程目录。',
  scanning: '正在检查工程结构和源码…',
  ready: '检查完成，尚未导入。',
  copying: '正在创建隔离的源码副本…',
  starting: '源码副本已导入，正在启动应用…',
  cancelling: '正在取消并核实清理…',
  cancelled: '本次导入操作已取消。',
  failed: '导入未完成。',
  completed: '已导入并启动。',
};

export function AppImportPanel({
  view,
  pending,
  locked,
  cleanupConfirmed,
  canRestart,
  onAction,
}: {
  view: ImportView;
  pending: string | null;
  locked: boolean;
  cleanupConfirmed: boolean;
  canRestart: boolean;
  onAction: (action: AppImportAction) => void;
}) {
  const preview = view.preview;
  const busy = !!pending || ['selecting', 'scanning', 'copying', 'starting', 'cancelling'].includes(view.phase);
  const canChoose = !view.published && !view.projectId && ['ready', 'failed'].includes(view.phase);
  const cancelledCopy = view.phase === 'cancelled' && view.published;
  const retryBlocked = view.published && !canRestart;
  return (
    <section className="app-import-panel" aria-label="导入已有工程">
      <h3>{view.phase === 'ready' ? '导入预览' : '工程导入'}</h3>
      <p className="app-import-stage" role="status" aria-live="polite">
        {cancelledCopy
          ? cleanupConfirmed
            ? '已取消后续启动，导入的项目副本保留。'
            : '导入后续步骤已取消，应用进程清理待确认。'
          : view.phase === 'failed' && view.published
            ? '项目副本已保留，本次操作未完成。'
            : stages[view.phase]}
      </p>
      {preview ? (
        <>
          <dl className="app-import-summary">
            <div>
              <dt>工程</dt>
              <dd>{preview.name}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>{preview.profile === 'mota-web' ? '魔塔游戏 · Node 运行环境' : 'edu-web · Python 3.12 + React'}</dd>
            </div>
            <div>
              <dt>源码副本</dt>
              <dd>
                {preview.fileCount} 个文件 ·{' '}
                {(preview.totalBytes / (preview.totalBytes >= 1024 * 1024 ? 1024 * 1024 : 1024)).toLocaleString('zh-CN', {
                  maximumFractionDigits: 1,
                })}{' '}
                {preview.totalBytes >= 1024 * 1024 ? 'MiB' : 'KiB'}
              </dd>
            </div>
          </dl>
          <details className="small app-import-source">
            <summary>来源详情</summary>
            {preview.profile === 'edu-web' ? (
              <>
                <p>
                  Git 提交：<code>{preview.repository.commit}</code>
                </p>
                <p>来源状态：{preview.repository.dirty ? '包含未提交修改' : '干净提交'}</p>
              </>
            ) : (
              <p>来源为所选目录的静态源码与游戏素材，按文件内容核对，不要求 Git 仓库。</p>
            )}
            <p>
              源码 SHA256：<code>{preview.sourceSha256}</code>
            </p>
          </details>
          {preview.warnings.length ? (
            <ul className="app-import-warnings small">
              {preview.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {view.phase === 'copying' && view.progress.files > 0 ? (
        <p className="muted small">
          已复制 {view.progress.files} 个文件 · {view.progress.bytes.toLocaleString('zh-CN')} 字节
        </p>
      ) : null}
      {view.phase === 'ready' ? (
        <div className="app-import-boundary small">
          <p>原工程目录保持不变。</p>
        </div>
      ) : null}
      {view.error ? <p role="alert">{view.error.message}</p> : null}
      {retryBlocked && view.canRetry ? <p className="muted small">确认应用已停止并完成清理后，才能重新启动。</p> : null}
      {view.phase === 'failed' && !view.published ? (
        <p className="muted small">
          {view.projectId
            ? view.canRetry
              ? '工程身份已保留，可重试本次导入。若要更换工程，请先核对并取消。'
              : '工程身份已保留，请先核对并取消；确认清理后再选择工程。'
            : '请按提示检查工程后重试，或重新选择完整的 edu Git 工程或魔塔工程目录。'}
        </p>
      ) : null}
      {appImportActive(view) && view.phase !== 'ready' ? (
        <p className="muted small">关闭此对话框只收起界面；操作会继续，可从空间的 App 入口重新查看进度。</p>
      ) : null}
      {locked ? <p className="muted small">发音验证尚未结束，暂不能导入或重新启动。</p> : null}
      <div className="row gap-8 app-import-actions">
        {view.phase === 'ready' && preview ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || locked}
            onClick={() => onAction({ type: 'confirmAppImport', previewId: view.previewId, sourceSha256: preview.sourceSha256 })}
          >
            确认导入并启动
          </button>
        ) : null}
        {view.canRetry ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || locked || retryBlocked}
            onClick={() => onAction({ type: 'retryAppImport', previewId: view.previewId })}
          >
            {view.published ? '重试启动' : '重试导入'}
          </button>
        ) : null}
        {canChoose ? (
          <button type="button" className="btn" disabled={busy || locked} onClick={() => onAction({ type: 'previewAppImport' })}>
            重新选择工程
          </button>
        ) : null}
        {view.canCancel ? (
          <button
            type="button"
            className="btn"
            disabled={pending === 'cancelAppImport' || view.phase === 'cancelling'}
            onClick={() => onAction({ type: 'cancelAppImport', previewId: view.previewId })}
          >
            {view.phase === 'failed' ? '核对并取消' : view.phase === 'starting' ? '取消启动' : '取消导入'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
