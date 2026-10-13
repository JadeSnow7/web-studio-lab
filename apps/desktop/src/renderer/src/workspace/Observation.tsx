import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ObservationRecord,
  StatusScope,
  WorkbenchObservationInput,
  WorkspaceObservationResult,
  WorkspaceSnapshot,
  WorkbenchSession,
} from '@wsl/protocol';
import { useImeForm } from '../lib/ime';
import { StatusDot } from '../components/Status';
import {
  observationErrorLine,
  observationRecordStateLabel,
  observationSourceState,
  useResourceUnavailableView,
  useStatusViewByKey,
  type StatusView,
} from '../state/status-view';
import { observationImage } from './presentation';
import { workspaceCommand } from '../state/workspace';

/** 现有观察取消入口：hook 的「取消观察」按钮与状态槽的 observation.cancel 动作共用。 */
export const cancelObservationRequest = (workspaceId: string, sessionId: string | null, requestId: string) =>
  workspaceCommand(workspaceId, { type: 'cancelObservation', sessionId, requestId });

export function useObservation(workspaceId: string, sessionId: string | null) {
  const [result, setResult] = useState<WorkspaceObservationResult | null>(null);
  const [pending, setPending] = useState(false);
  /** 当前结果对应的请求 id：展示层用它按 observation:<requestId>:* 取状态视图。 */
  const [requestId, setRequestId] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (request.current) void cancelObservationRequest(workspaceId, sessionId, request.current);
      request.current = null;
    },
    [workspaceId, sessionId],
  );
  const observe = async (input: Omit<WorkbenchObservationInput, 'workspaceId' | 'sessionId' | 'requestId'>) => {
    if (request.current) return;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    setPending(true);
    setResult(null);
    setRequestId(requestId);
    try {
      const next = await window.studio.workbench.observe({ ...input, workspaceId, sessionId, requestId });
      if (request.current === requestId) setResult(next);
    } catch (error) {
      if (request.current === requestId) setResult({ error: 'unavailable', message: (error as Error).message });
    } finally {
      if (request.current === requestId) {
        request.current = null;
        setPending(false);
      }
    }
  };
  const cancel = () => {
    if (request.current) void cancelObservationRequest(workspaceId, sessionId, request.current);
  };
  return { result, requestId, pending, observe, cancel };
}

export const environmentNames: Record<string, string> = { local: '本设备', sandbox: '沙箱', ssh: 'SSH' };
const sourceNames: Record<string, string> = {
  disk: '本地文件',
  sftp: '远端文件',
  'disk-search': '本地搜索',
  'sftp-search': '远端搜索',
  accessibility: '网页结构',
  screenshot: '网页截图',
  'runtime-events': '页面事件',
  terminal_screen: '终端屏幕',
  terminal_output: '终端输出',
  terminal_commands: '终端命令',
};
/**
 * 观察结果。顶部只有健康稳态的形状（覆盖完整）与「来源」折叠区；来源、环境、时间、范围、版本 / 散列是结果元数据，展开即可见。
 * 进行中、失败、覆盖不完整 / 未知、文件可能变化是状态：由展示层的 observation:<requestId>:* / file:<id>:hint 视图提供，
 * 在所属窗格的状态槽呈现，这里不再拼「覆盖 …」一类状态文字。
 * - announce：错误行是否自己播报（role="alert"）。已有失败视图在状态槽播报时为 false，避免同一条失败播报两次；
 *   已取消的观察不产出事实，错误行是唯一的呈现，仍用 alert。
 * - coverage / coverageLabel：覆盖视图；当前结果只传稳态（形状 + 视觉隐藏文字），历史记录没有状态槽，传入任意覆盖视图并显示文字。
 */
export function ObservationResult({
  result,
  announce = false,
  coverage = null,
  coverageLabel = false,
}: {
  result: WorkspaceObservationResult | null;
  announce?: boolean;
  coverage?: StatusView | null;
  coverageLabel?: boolean;
}) {
  if (!result) return <p className="muted">尚未读取。</p>;
  if ('error' in result)
    return (
      <p role={announce ? 'alert' : undefined} className={announce ? undefined : 'muted'}>
        {observationErrorLine(result)}
      </p>
    );
  if ('kind' in result)
    return (
      <ul>
        {result.sources.map((source) => (
          <li key={source.resource.resourceId}>
            {source.title} ·{' '}
            {source.resource.environmentId
              ? (environmentNames[source.resource.environmentId] ?? source.resource.environmentId)
              : '未绑定环境'}{' '}
            · {observationSourceState(source)}
          </li>
        ))}
      </ul>
    );
  const image = observationImage(result);
  const metadata = Object.fromEntries(Object.entries(result.data).filter(([key]) => !['base64', 'dataUrl', 'text'].includes(key)));
  return (
    <div className="observation-result">
      <div className="observation-meta">
        {coverage ? (
          <span className="observation-coverage">
            <StatusDot view={coverage} visibleLabel={coverageLabel} />
            {coverageLabel && coverage.detail ? <span className="muted small">{coverage.detail}</span> : null}
          </span>
        ) : null}
        <details className="observation-source">
          <summary>来源</summary>
          <p className="small">
            {sourceNames[result.source] ?? result.source} · 环境{' '}
            {environmentNames[result.resource.environmentId] ?? result.resource.environmentId} ·{' '}
            {new Date(result.capturedAt).toLocaleString('zh-CN')}
          </p>
          {result.coverage.range ? <p className="small">范围 {JSON.stringify(result.coverage.range)}</p> : null}
          <p className="small">版本 / 散列 {result.revision.value}</p>
        </details>
      </div>
      {image ? (
        <img className="context-image" src={image} alt={result.source === 'screenshot' ? '网页观察截图' : '只读文件图像'} />
      ) : result.data.imageInputRequired || result.source === 'screenshot' ? (
        <p role="status">此图像格式或大小不能内联显示；请查看读取范围和元数据。</p>
      ) : null}
      {typeof result.data.text === 'string' ? (
        <pre>{result.data.text}</pre>
      ) : (
        <details>
          <summary>结果详情</summary>
          <pre>{JSON.stringify(metadata, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * 当前结果：用 observation:<requestId>:state / coverage 视图决定错误行是否播报、是否外露覆盖稳态。
 * scope 是该观察所属的范围（会话页为会话，文件页为资源），与 shared/status 的 observationFacts 同一规则。
 */
export function CurrentObservation({
  scope,
  requestId,
  result,
}: {
  scope: StatusScope;
  requestId: string | null;
  result: WorkspaceObservationResult | null;
}) {
  const state = useStatusViewByKey(scope, `observation:${requestId ?? ''}:state`);
  const coverage = useStatusViewByKey(scope, `observation:${requestId ?? ''}:coverage`);
  // 错误行在失败视图不是槽里当前可见的那一条时自己播报（没有失败视图、已是历史、或折叠在「另有 N 项」里）；否则由槽播报。
  const announce = !state || !!state.historical || !state.visible;
  return <ObservationResult result={result} announce={announce} coverage={coverage?.kind === 'steady' ? coverage : null} />;
}

function HistoryResult({ scope, record }: { scope: StatusScope; record: ObservationRecord }) {
  const coverage = useStatusViewByKey(scope, `observation:${record.request.requestId}:coverage`);
  return <ObservationResult result={record.result} coverage={coverage} coverageLabel />;
}

export function ObservationHistory({ records, scope }: { records: ObservationRecord[]; scope: StatusScope }) {
  return (
    <details className="observation-history">
      <summary>观察历史 · {records.length} 条</summary>
      <p className="muted small">仅展示最近 200 条；移出窗口的不可变证据仍保留归档。</p>
      {records.length ? (
        [...records].reverse().map((record) => (
          <details key={record.request.requestId}>
            <summary>
              {toolLabels[record.request.tool] ?? record.request.tool} · {observationRecordStateLabel(record.state)} ·{' '}
              {new Date(record.startedAt).toLocaleString('zh-CN')}
            </summary>
            <HistoryResult scope={scope} record={record} />
          </details>
        ))
      ) : (
        <p>尚无观察记录。</p>
      )}
    </details>
  );
}

const toolLabels: Record<string, string> = {
  'workspace.list_sources': '来源列表',
  'browser.snapshot': '网页结构',
  'browser.query': '网页元素',
  'browser.screenshot': '网页截图',
  'browser.read_events': '页面事件',
  'terminal.read_screen': '终端屏幕',
  'terminal.read_output': '终端输出',
  'terminal.read_command': '终端命令',
  'files.list': '目录列表',
  'files.search': '搜索文件',
  'files.read': '读取文件',
};
const tools = {
  browser: ['browser.snapshot', 'browser.screenshot', 'browser.read_events'],
  terminal: ['terminal.read_screen', 'terminal.read_output', 'terminal.read_command'],
  file: ['files.list', 'files.search', 'files.read'],
} as const;
export function SessionObservation({ workspace, session }: { workspace: WorkspaceSnapshot; session: WorkbenchSession }) {
  const ime = useImeForm();
  const { result, requestId, pending, observe, cancel } = useObservation(workspace.workspaceId, session.sessionId);
  // 观察归属会话：scope 与 shared/status 的 observationFacts 一致（会话优先）。
  const scope = useMemo<StatusScope>(
    () => ({ kind: 'session', workspaceId: workspace.workspaceId, sessionId: session.sessionId }),
    [workspace.workspaceId, session.sessionId],
  );
  const [resourceId, setResourceId] = useState('');
  const [tool, setTool] = useState<WorkbenchObservationInput['tool']>('workspace.list_sources');
  const searchInput = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState('.'),
    [query, setQuery] = useState('');
  const resource = workspace.resources.find((resource) => resource.resourceId === resourceId);
  const kind = resource?.kind === 'web' ? 'browser' : resource?.kind === 'ssh' ? 'terminal' : resource?.kind;
  const actions = kind && kind in tools ? tools[kind as keyof typeof tools] : [];
  const currentRun = workspace.runs.filter((run) => run.sessionId === session.sessionId).at(-1);
  const runId = currentRun && ['starting', 'running'].includes(currentRun.state) ? currentRun.runId : null;
  // 文件可能变化：事实在资源 scope，这里取所选资源的那一条（文案来自展示层，不再外露原始枚举）。
  const resourceScope = useMemo<StatusScope>(
    () => ({ kind: 'resource', workspaceId: workspace.workspaceId, resourceId }),
    [workspace.workspaceId, resourceId],
  );
  const hint = useStatusViewByKey(resourceScope, `file:${resourceId}:hint`);
  const unavailable = useResourceUnavailableView(resourceScope);
  return (
    <section className="observation-context" aria-label="会话统一观察">
      <h3>资源观察</h3>
      <p className="muted small">
        {workspace.name} / {session.title} · 读取不会自动发送或执行任务。
      </p>
      <form
        noValidate
        {...ime.handlers}
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && !ime.composing.current)
            void observe({
              resourceId: tool === 'workspace.list_sources' ? null : resourceId,
              runId,
              tool,
              args: tool.startsWith('files.') ? { path, ...(tool === 'files.search' ? { query } : {}) } : {},
            });
        }}
      >
        <label className="field">
          观察来源
          <select
            value={resourceId}
            disabled={pending}
            onChange={(event) => {
              const id = event.target.value;
              setResourceId(id);
              const resource = workspace.resources.find((resource) => resource.resourceId === id);
              setTool(
                resource?.kind === 'web'
                  ? 'browser.snapshot'
                  : resource?.kind === 'terminal' || resource?.kind === 'ssh'
                    ? 'terminal.read_screen'
                    : resource?.kind === 'file'
                      ? 'files.list'
                      : 'workspace.list_sources',
              );
            }}
          >
            <option value="">本空间来源列表</option>
            {workspace.resources
              .filter((resource) => resource.kind !== 'session')
              .map((resource) => (
                <option key={resource.resourceId} value={resource.resourceId}>
                  {resource.title} · {resource.environmentId ?? '未绑定'}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          读取动作
          <select value={tool} disabled={pending} onChange={(event) => setTool(event.target.value as typeof tool)}>
            {resourceId ? (
              actions.map((action) => (
                <option key={action} value={action}>
                  {toolLabels[action]}
                </option>
              ))
            ) : (
              <option value="workspace.list_sources">列出本空间来源</option>
            )}
          </select>
        </label>
        {kind === 'file' ? (
          <>
            <label className="field">
              观察路径
              <input disabled={pending} value={path} maxLength={4096} onChange={(event) => setPath(event.target.value)} />
            </label>
            {tool === 'files.search' ? (
              <label className="field">
                观察搜索
                <input
                  disabled={pending}
                  ref={searchInput}
                  value={query}
                  maxLength={200}
                  onChange={(event) => setQuery(event.target.value)}
                />
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
                    清除观察搜索
                  </button>
                ) : null}
              </label>
            ) : null}
          </>
        ) : null}
        <button
          className="btn"
          type="submit"
          disabled={
            pending ||
            (!!resourceId && (!resource?.environmentId || !!resource.unavailableReason)) ||
            (tool === 'files.search' && !query.trim())
          }
        >
          读取观察
        </button>
        {/* 进行中的文字与「取消读取」在会话状态槽的常驻通道（observation:<id>:state）；这里只保留表单旁的取消控件，不再重复状态文字。 */}
        {pending ? (
          <button type="button" className="btn" onClick={cancel}>
            取消观察
          </button>
        ) : null}
      </form>
      {unavailable ? <p role="status">{unavailable.label}</p> : null}
      {hint ? (
        <p className="status-field" role="status">
          <StatusDot view={hint} visibleLabel title={`${hint.label}（提示不是完整监视）`} />
        </p>
      ) : null}
      <div role="region" aria-label="当前观察结果">
        <CurrentObservation scope={scope} requestId={requestId} result={result} />
      </div>
      <ObservationHistory records={session.observations} scope={scope} />
    </section>
  );
}
