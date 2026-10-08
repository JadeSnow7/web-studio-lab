import { useEffect, useRef, useState } from 'react';
import type {
  ObservationRecord,
  WorkbenchObservationInput,
  WorkspaceObservationResult,
  WorkspaceSnapshot,
  WorkbenchSession,
} from '@wsl/protocol';
import { useImeForm } from '../lib/ime';
import { observationImage } from './presentation';
import { workspaceCommand } from '../state/workspace';

export function useObservation(workspaceId: string, sessionId: string | null) {
  const [result, setResult] = useState<WorkspaceObservationResult | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (request.current) void workspaceCommand(workspaceId, { type: 'cancelObservation', sessionId, requestId: request.current });
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
    if (request.current) void workspaceCommand(workspaceId, { type: 'cancelObservation', sessionId, requestId: request.current });
  };
  return { result, pending, observe, cancel };
}

const environmentNames: Record<string, string> = { local: '本设备', sandbox: '沙箱', ssh: 'SSH' };
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
const errorNames: Record<string, string> = {
  cancelled: '已取消',
  unavailable: '不可用',
  unauthorized: '未获授权',
  unsupported: '不支持',
  not_found: '未找到',
  stale_cursor: '续读已失效',
  stale_ref: '引用已失效',
  gap: '输出有缺口',
  invalid_request: '输入无效',
  timeout: '读取超时',
  unstable: '内容不稳定',
  budget_exceeded: '超出读取预算',
};
export function ObservationResult({ result }: { result: WorkspaceObservationResult | null }) {
  if (!result) return <p className="muted">尚未读取。</p>;
  if ('error' in result)
    return (
      <p role="alert">
        {errorNames[result.error]} · {result.message}。请核对来源或重新读取。
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
            · {{ live: '活动', closed: '已关闭', unavailable: '不可用' }[source.state]}
            {source.reason ? ` · ${source.reason}` : ''}
          </li>
        ))}
      </ul>
    );
  const image = observationImage(result);
  const metadata = Object.fromEntries(Object.entries(result.data).filter(([key]) => !['base64', 'dataUrl', 'text'].includes(key)));
  const coverage = { complete: '完整', partial: '部分', unknown: '未知' }[result.coverage.status];
  return (
    <div className="observation-result">
      <p className="muted small">
        来源 {sourceNames[result.source] ?? result.source} · 环境{' '}
        {environmentNames[result.resource.environmentId] ?? result.resource.environmentId} ·{' '}
        {new Date(result.capturedAt).toLocaleString('zh-CN')}
      </p>
      <p role="status">
        覆盖 {coverage}
        {result.coverage.reasons?.length ? ` · ${result.coverage.reasons.join('、')}` : ''}
      </p>
      {result.coverage.range ? <p>范围 {JSON.stringify(result.coverage.range)}</p> : null}
      <p className="small">版本 / 散列 {result.revision.value}</p>
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
      {result.evidenceRef ? (
        <details>
          <summary>观察证据</summary>
          <p className="small">{result.evidenceRef}</p>
        </details>
      ) : null}
    </div>
  );
}

export function ObservationHistory({ records }: { records: ObservationRecord[] }) {
  return (
    <details className="observation-history">
      <summary>观察历史 · {records.length} 条</summary>
      <p className="muted small">仅展示最近 200 条；移出窗口的不可变证据仍保留归档。</p>
      {records.length ? (
        [...records].reverse().map((record) => (
          <details key={record.request.requestId}>
            <summary>
              {record.request.tool} · {record.state} · {new Date(record.startedAt).toLocaleString('zh-CN')}
            </summary>
            <p className="small">
              空间 {record.request.workspaceId} · 会话 {record.request.sessionId ?? '文件浏览'} · 运行 {record.request.runId ?? '无运行'}
            </p>
            {record.request.target ? (
              <p className="small">
                资源 {record.request.target.resourceId} · 环境 {record.request.target.environmentId} · 实例{' '}
                {record.request.target.instanceId} / {record.request.target.instanceGeneration}
              </p>
            ) : null}
            <ObservationResult result={record.result} />
            {record.evidenceRef ? <p className="small">归档 {record.evidenceRef}</p> : null}
          </details>
        ))
      ) : (
        <p>尚无观察记录。</p>
      )}
    </details>
  );
}

const toolLabels: Record<string, string> = {
  'browser.snapshot': '网页结构',
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
  const { result, pending, observe, cancel } = useObservation(workspace.workspaceId, session.sessionId);
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
  const hint = workspace.fileHints.find((hint) => hint.resourceId === resourceId);
  return (
    <section className="observation-context" aria-label="会话统一观察">
      <h3>资源观察</h3>
      <p className="muted small">
        {workspace.name} / {session.title} · {runId ? `运行 ${runId}` : '会话上下文（无活动运行）'} · 读取不会自动发送或执行任务。
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
        {pending ? (
          <>
            <span role="status">正在读取，归属已冻结…</span>
            <button type="button" className="btn" onClick={cancel}>
              取消观察
            </button>
          </>
        ) : null}
      </form>
      {resource?.unavailableReason ? <p role="status">{resource.unavailableReason}</p> : null}
      {hint ? (
        <p role="status">
          文件可能变化 · {hint.change} · {new Date(hint.capturedAt).toLocaleString('zh-CN')}；请重新读取。提示不是完整监视。
        </p>
      ) : null}
      <div role="region" aria-label="当前观察结果">
        <ObservationResult result={result} />
      </div>
      <ObservationHistory records={session.observations} />
    </section>
  );
}
