import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { StatusScope, WorkbenchResource, WorkspaceSnapshot } from '@wsl/protocol';
import { StatusSlot } from '../components/Status';
import { useImeForm } from '../lib/ime';
import { ackScope, entityOf, statusPresentationActions, useStatusView, type StatusView } from '../state/status-view';
import { CurrentObservation, ObservationHistory, cancelObservationRequest, environmentNames, useObservation } from './Observation';

/** 首次打开文件标签的说明：不变量（授权根、不加入会话、变化提示的覆盖范围）只在这里说一次，不常驻。 */
const firstUseLabel = (environmentId: string | null) =>
  `仅访问已授权根内的文件，浏览不加入 Agent 会话。${
    environmentId === 'ssh' ? 'SFTP 不提供 watch；重新读取核对内容。' : '变化提示只覆盖已观察目录，未提示不代表内容未变。'
  }`;

export function Files({ workspace, resource }: { workspace: WorkspaceSnapshot; resource: WorkbenchResource }) {
  const ime = useImeForm();
  const searchInput = useRef<HTMLInputElement>(null);
  const [capturedPath, setCapturedPath] = useState(resource.url ?? '.');
  const [path, setPath] = useState(resource.url ?? '.'),
    [query, setQuery] = useState('');
  const { result, requestId, pending, observe } = useObservation(workspace.workspaceId, null);
  const { workspaceId } = workspace;
  const { resourceId } = resource;
  const scope = useMemo<StatusScope>(() => ({ kind: 'resource', workspaceId, resourceId }), [workspaceId, resourceId]);
  const pathInput = useRef<HTMLInputElement>(null);
  const notesId = useId();
  const notes = firstUseLabel(resource.environmentId);
  // 首次打开该标签时登记一次（hintOnce）；关闭或与窗格交互后清除，重新打开同一标签不再出现。
  useEffect(() => {
    statusPresentationActions.hintOnce({
      key: `ui:${resourceId}:first-use`,
      scope,
      label: notes,
      source: 'first-use',
      until: 'ack',
    });
  }, [resourceId, notes, scope]);
  const available = !!resource.environmentId && !resource.unavailableReason;
  const capture = result && !('error' in result) && !('kind' in result) ? result : null;
  const matches = capture?.data.matches as Array<{ path: string; line: number; text: string }> | undefined;
  const entries = capture?.data.entries as Array<{ name: string; kind: string }> | undefined;
  const read = (tool: 'files.list' | 'files.search' | 'files.read', nextPath = path, cursor?: string) => {
    setPath(nextPath);
    setCapturedPath(nextPath);
    void observe({
      resourceId: resource.resourceId,
      runId: null,
      tool,
      args: { path: nextPath, ...(tool === 'files.search' ? { query } : {}), ...(cursor ? { cursor } : {}) },
    });
  };
  // 焦点不落 body：读取结束（取消读取、完成）或首次说明被「知道了」关闭后，原先聚焦的控件已禁用 / 卸载，把焦点交给路径输入框。
  // 只在焦点确实丢到 body 时处理，不抢用户已经移到别处的焦点；说明被关闭时只处理焦点原本在状态槽内的情形。
  const hasNotice = !!useStatusView(scope).notice;
  const slotFocus = useRef(false);
  const settled = useRef({ pending, notice: hasNotice });
  useEffect(() => {
    const before = settled.current;
    settled.current = { pending, notice: hasNotice };
    const finished = before.pending && !pending;
    const dismissed = before.notice && !hasNotice && slotFocus.current;
    if (!finished && !dismissed) return;
    slotFocus.current = false;
    // 延后一个任务：Enter 触发「知道了」时，同一次按键的默认动作（keypress）还没派发，立刻移动焦点会让它落到路径输入框并提交表单。
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) pathInput.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pending, hasNotice]);
  // 取消读取：状态槽常驻通道的 observation.cancel 动作，执行现有的 cancelObservation 命令。
  const onAction = (view: StatusView) => {
    if (view.action?.id === 'observation.cancel' && !view.action.disabled) void cancelObservationRequest(workspaceId, null, entityOf(view));
  };
  // 与窗格交互（点击、按键、键盘焦点）后确认其中的 hint / confirmation；control / progress / problem 不受影响。
  // 点击在 click 里确认；鼠标点按钮引起的焦点不算，键盘 / 文本输入的焦点才算。
  const acknowledge = () => ackScope(scope);
  // 状态槽内的按键不算：「知道了」由 Enter / 空格触发的 click 关闭；若在 keydown 就确认，按钮会先被卸载，
  // 同一次按键的后续默认动作（keypress）会落到被移走焦点的新目标上。
  const acknowledgeKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.target as HTMLElement).closest('.status-slot')) acknowledge();
  };
  // 状态槽内的焦点不算：Tab 进入「知道了」时说明必须仍在，由用户自己确认。
  const acknowledgeFocus = (event: React.FocusEvent<HTMLElement>) => {
    const inSlot = !!event.target.closest('.status-slot');
    slotFocus.current = inSlot;
    if (!inSlot && event.target.matches(':focus-visible')) acknowledge();
  };
  return (
    <section
      className="file-panel"
      aria-label="只读文件浏览"
      onClickCapture={acknowledge}
      onKeyDownCapture={acknowledgeKey}
      onFocusCapture={acknowledgeFocus}
    >
      <header className="file-panel-header">
        <h2>{resource.title}</h2>
        {/* 环境名是标题元数据，不是状态。 */}
        {/* 首次说明之外，授权根 / 变化提示覆盖范围 / SFTP 无 watch 的说明始终可得：悬停 title 与 aria-describedby，不常驻可见文字。 */}
        <span className="muted small" title={notes} aria-describedby={notesId}>
          {resource.environmentId ? (environmentNames[resource.environmentId] ?? resource.environmentId) : '未绑定环境'}
        </span>
        <span className="sr-only" id={notesId}>
          {notes}
        </span>
      </header>
      {/* 状态槽固定在内容滚动区之上：进行中（取消读取）、读取失败、覆盖不完整、文件可能变化与首次说明。 */}
      <StatusSlot scope={scope} onAction={onAction} />
      <div className="file-panel-body">
        <form
          noValidate
          {...ime.handlers}
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && available && !ime.composing.current) read('files.list');
          }}
        >
          <label className="field">
            文件路径
            <input ref={pathInput} disabled={pending} value={path} maxLength={4096} onChange={(event) => setPath(event.target.value)} />
          </label>
          <div className="row gap-8">
            <button type="submit" className="btn" disabled={pending || !available}>
              列出目录
            </button>
            <button type="button" className="btn" disabled={pending || !available} onClick={() => read('files.read')}>
              读取文件
            </button>
          </div>
          <label className="field">
            文件搜索
            <input disabled={pending} ref={searchInput} value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {query ? (
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => {
                setQuery('');
                searchInput.current?.focus();
              }}
            >
              清除文件搜索
            </button>
          ) : null}
          <button type="button" className="btn" disabled={pending || !available || !query.trim()} onClick={() => read('files.search')}>
            搜索文件
          </button>
        </form>
        {entries ? (
          <ul aria-label="目录条目">
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="btn"
                  disabled={pending || (entry.kind !== 'directory' && entry.kind !== 'file')}
                  onClick={() =>
                    read(
                      entry.kind === 'directory' ? 'files.list' : 'files.read',
                      `${String(capture?.data.path ?? capturedPath).replace(/\/$/, '')}/${entry.name}`,
                    )
                  }
                >
                  {entry.name} · {entry.kind}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {result || pending ? <p className="muted small">读取范围：{capturedPath}</p> : null}
        {matches ? (
          <ul aria-label="文件搜索结果">
            {matches.map((match, index) => (
              <li key={`${match.path}:${match.line}:${index}`}>
                <button type="button" className="btn" disabled={pending} onClick={() => read('files.read', match.path)}>
                  {match.path}:{match.line} · {match.text}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div role="region" aria-label="当前文件结果">
          <CurrentObservation scope={scope} requestId={requestId} result={result} />
        </div>
        {capture?.nextCursor ? (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => read('files.read', String(capture.data.path ?? capturedPath), capture.nextCursor)}
          >
            继续读取
          </button>
        ) : null}
        <ObservationHistory
          records={workspace.observations.filter((record) => record.request.target?.resourceId === resource.resourceId)}
          scope={scope}
        />
      </div>
    </section>
  );
}
