import type { WorkbenchRun } from '@wsl/protocol';
import { researchSummaryPresentation } from './research-presentation';

export function ResearchSources({ run }: { run: WorkbenchRun }) {
  const research = researchSummaryPresentation(run);
  if (!research) return null;
  return (
    <details>
      <summary>
        公开网页来源 · 已读取 {research.sources.length} 条 · 已纳入 {research.includedCount} 条
      </summary>
      <p className="muted small">搜索候选不代表已读取；“已纳入”表示模型已选择这份正文作为本次运行的参考。</p>
      {research.incomplete ? <p className="muted small">搜索或来源记录不完整，不能据此确认全部来源。</p> : null}
      {research.searches.length ? (
        <details>
          <summary>搜索过程 · {research.searches.length} 条</summary>
          {research.searches.map((search) => (
            <div key={`${search.turnId}:${search.itemId}`}>
              <p>{search.label}</p>
              {search.query ? <p>{search.query}</p> : null}
              {search.candidateUrls?.map((url, index) => (
                <pre key={`${index}:${url}`}>候选：{url}</pre>
              ))}
              {search.schemaUnsupported || search.truncated ? <p className="muted small">此条搜索记录不完整。</p> : null}
            </div>
          ))}
        </details>
      ) : null}
      {research.sources.map((source) => (
        <div key={source.captureId}>
          <p>
            <strong>{source.title || '公开网页'}</strong> · {source.included ? '已纳入本次运行' : '已读取，未纳入'}
          </p>
          <pre>{source.url}</pre>
          <p className="muted small">
            读取于 {new Date(source.capturedAt).toLocaleString('zh-CN')}
            {source.truncated ? ' · 正文已截断' : ''}
          </p>
        </div>
      ))}
    </details>
  );
}
