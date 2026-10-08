import { useRef, useState } from 'react';
import type { WorkbenchResource, WorkspaceSnapshot } from '@wsl/protocol';
import { useImeForm } from '../lib/ime';
import { ObservationHistory, ObservationResult, useObservation } from './Observation';

export function Files({ workspace, resource }: { workspace: WorkspaceSnapshot; resource: WorkbenchResource }) {
  const ime = useImeForm();
  const searchInput = useRef<HTMLInputElement>(null);
  const [capturedPath, setCapturedPath] = useState('.');
  const [path, setPath] = useState('.'),
    [query, setQuery] = useState('');
  const { result, pending, observe, cancel } = useObservation(workspace.workspaceId, null);
  const available = !!resource.environmentId && !resource.unavailableReason;
  const capture = result && !('error' in result) && !('kind' in result) ? result : null;
  const matches = capture?.data.matches as Array<{ path: string; line: number; text: string }> | undefined;
  const entries = capture?.data.entries as Array<{ name: string; kind: string }> | undefined;
  const hint = workspace.fileHints.find((hint) => hint.resourceId === resource.resourceId);
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
  return (
    <section className="file-panel" aria-label="只读文件浏览">
      <h2>{resource.title}</h2>
      <p className="muted">{resource.environmentId ?? '未绑定环境'} · 仅访问已授权根内的文件 · 浏览不加入 Agent 会话</p>
      {!available ? <p role="status">{resource.unavailableReason ?? '此资源没有授权环境，请新建标签并明确选择已配置环境。'}</p> : null}
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
          <input disabled={pending} value={path} maxLength={4096} onChange={(event) => setPath(event.target.value)} />
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
      {pending ? (
        <div role="status">
          正在读取…
          <button type="button" className="btn" onClick={cancel}>
            取消读取
          </button>
        </div>
      ) : null}
      {hint ? (
        <p role="status">文件可能变化 · {hint.change}；续读可能失效，请重新读取。目录提示有覆盖缺口。</p>
      ) : (
        <p className="muted small">
          {resource.environmentId === 'ssh' ? 'SFTP 不提供 watch；重新读取核对内容。' : '变化提示只覆盖已观察目录，未提示不代表内容未变。'}
        </p>
      )}
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
      <p className="muted small">读取范围：{capturedPath}</p>
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
        <ObservationResult result={result} />
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
      <ObservationHistory records={workspace.observations.filter((record) => record.request.target?.resourceId === resource.resourceId)} />
    </section>
  );
}
