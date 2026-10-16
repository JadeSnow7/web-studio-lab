import { useMemo, useState } from 'react';
import type { SourceChangeFile } from '@wsl/protocol';

type PatchFile = Omit<SourceChangeFile, 'binary'> & { binary?: boolean };

export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) return 'diff-meta';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

function PagedPatch({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split('\n'), [patch]);
  const [page, setPage] = useState(0);
  const pageSize = 500;
  const lastPage = Math.floor((lines.length - 1) / pageSize);
  const start = page * pageSize;
  const end = Math.min(start + pageSize, lines.length);
  return (
    <>
      {lastPage > 0 ? (
        <nav className="row wrap gap-8" aria-label="源码 diff 分页">
          <button type="button" className="btn" disabled={page === 0} onClick={() => setPage(0)}>
            首页
          </button>
          <button type="button" className="btn" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            上一页
          </button>
          <span className="muted" aria-live="polite">
            显示第 {start + 1}–{end} 行 / 共 {lines.length} 行（仅本页；其余证据请翻页）
          </span>
          <button
            type="button"
            className="btn"
            disabled={page === lastPage}
            onClick={() => setPage((value) => Math.min(lastPage, value + 1))}
          >
            下一页
          </button>
          <button type="button" className="btn" disabled={page === lastPage} onClick={() => setPage(lastPage)}>
            末页
          </button>
        </nav>
      ) : null}
      <pre className="diff" aria-label="源码 diff" tabIndex={0}>
        {lines.slice(start, end).map((line, index) => (
          <span key={start + index} className={diffLineClass(line)}>
            {line || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </>
  );
}

export function PatchView({
  files,
  patch,
  emptyText = '没有改动文件。',
}: {
  files: readonly PatchFile[];
  patch: string | null;
  emptyText?: string;
}) {
  return (
    <>
      <div className="diff-files" role="list" aria-label="修改文件">
        {files.length === 0 ? <span className="muted">{emptyText}</span> : null}
        {files.map((file) => (
          <span key={file.path} className="chip" role="listitem">
            {file.change === 'added' ? 'A' : file.change === 'deleted' ? 'D' : file.change === 'renamed' ? 'R' : 'M'} {file.path}{' '}
            {file.binary ? (
              <span>二进制</span>
            ) : (
              <>
                <span className="text-ok">+{file.additions}</span> <span className="text-bad">−{file.deletions}</span>
              </>
            )}
          </span>
        ))}
      </div>
      {patch ? <PagedPatch key={patch} patch={patch} /> : null}
    </>
  );
}
