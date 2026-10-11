import { useRef, useState } from 'react';
import { BookmarkUrlSchema, type CatalogSummary, type ResourceRevision } from '@wsl/protocol';
import { Notice } from '../components/Badges';
import { useStore } from '../lib/store';
import { useImeForm } from '../lib/ime';
import { workspaceStore, initializeWorkspace, beginNavigation, isCurrentNavigation } from '../state/workspace';
import { useCatalogMutation } from '../state/catalog';
import { uiActions } from '../state/ui';
import { shellActions } from '../state/shell';
import { catalogCommand, switchWorkspace } from '../state/workspace';
type Item = CatalogSummary['resources'][number];
const kindLabel = { web: '网页', development: '开发资源', document: '文档' };
export function resourceLocation(item: Item) {
  return item.descriptor.kind === 'web'
    ? item.descriptor.url
    : (item.descriptor.path ??
        (item.descriptor.kind === 'development' && item.descriptor.entryKind === 'project'
          ? '受管项目'
          : (item.descriptor.environmentId ?? '未绑定环境')));
}
export function ResourcesPage() {
  const state = useStore(workspaceStore, (s) => s);
  const catalog = state.snapshot?.catalog;
  const [category, setCategory] = useState('all'),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState(''),
    [url, setUrl] = useState(''),
    [validation, setValidation] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null),
    titleInput = useRef<HTMLInputElement>(null),
    urlInput = useRef<HTMLInputElement>(null);
  const ime = useImeForm();
  const action = useCatalogMutation();
  const favorites = catalog?.resources.filter((item) => catalog.library.some((entry) => entry.resourceId === item.resourceId)) ?? [];
  const filtered = favorites.filter(
    (item) =>
      (category === 'all' || item.descriptor.kind === category) &&
      `${item.title} ${resourceLocation(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 10)),
    current = Math.min(page, pages),
    items = filtered.slice((current - 1) * 10, current * 10);
  const detail = favorites.find((item) => item.resourceId === selected);
  return (
    <section className="page-main resources-page" aria-label="我的资源">
      <div className="stack-8">
        <h1 id="resource-list-heading" tabIndex={-1}>
          我的资源
        </h1>
        <p className="muted">保存开发资源、网页和文档，在需要时连接到空间。</p>
      </div>
      <form
        className="resource-bookmark-form"
        noValidate
        {...ime.handlers}
        onSubmit={async (e) => {
          e.preventDefault();
          if (ime.composing.current || action.busy) return;
          setValidation(null);
          if (!title.trim()) {
            setValidation('请填写资源名称');
            titleInput.current?.focus();
            return;
          }
          if (!BookmarkUrlSchema.safeParse(url).success) {
            setValidation('请填写无凭据的 HTTP 或 HTTPS 链接');
            urlInput.current?.focus();
            return;
          }
          if (await action.mutate({ type: 'bookmarkLink', title, url }, '已收藏链接，尚未保存正文快照。')) {
            setTitle('');
            setUrl('');
            titleInput.current?.focus();
          }
        }}
      >
        <label className="field">
          资源名称
          <input
            ref={titleInput}
            value={title}
            maxLength={4096}
            disabled={action.busy}
            aria-invalid={!!validation && !title.trim()}
            aria-describedby={validation ? 'bookmark-validation' : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          网页链接
          <input
            ref={urlInput}
            value={url}
            maxLength={2048}
            disabled={action.busy}
            aria-invalid={!!validation && !!title.trim()}
            aria-describedby={validation ? 'bookmark-validation' : undefined}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={action.busy || !catalog}>
          收藏链接
        </button>
      </form>
      {validation ? (
        <p id="bookmark-validation" role="alert">
          {validation}
        </p>
      ) : null}
      <p className="muted small">收藏链接只保存地址，不访问网页，不自动连接空间或加入会话。</p>
      <div className="row wrap gap-12 resource-filters">
        <label className="field">
          资源分类
          <select
            aria-label="资源分类"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">全部</option>
            <option value="development">开发资源</option>
            <option value="web">网页</option>
            <option value="document">文档</option>
          </select>
        </label>
        <label className="field resource-search">
          搜索收藏
          <input
            ref={search}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
        {query ? (
          <button
            className="btn"
            onClick={() => {
              setQuery('');
              setPage(1);
              search.current?.focus();
            }}
          >
            清除搜索
          </button>
        ) : null}
        <button type="button" className="btn" disabled={action.busy} onClick={() => void initializeWorkspace(true)}>
          重新读取资源
        </button>
      </div>
      {state.error ? <Notice tone="warn">{state.error}</Notice> : null}
      {action.error ? <p role="alert">{action.error}</p> : null}
      {action.notice ? <p role="status">{action.notice}</p> : null}
      {!catalog ? (
        <p role="status">正在读取资源…</p>
      ) : !favorites.length ? (
        <Notice>还没有收藏资源。可收藏网页链接，或在空间资源区收藏已有内容。</Notice>
      ) : !filtered.length ? (
        <Notice>没有符合条件的收藏。请清除搜索或更换分类。</Notice>
      ) : (
        <>
          <p className="muted small" role="status">
            共 {filtered.length} 条收藏 · 第 {current} / {pages} 页
          </p>
          <div className="resource-catalog-list" aria-busy={action.busy}>
            {items.map((item) => (
              <article className="resource-catalog-row" key={item.resourceId}>
                <div className="stack-8">
                  <button
                    type="button"
                    className="link-btn resource-title"
                    aria-pressed={selected === item.resourceId}
                    onClick={() => setSelected(item.resourceId)}
                  >
                    {item.title}
                  </button>
                  <p className="muted small resource-location">{resourceLocation(item)}</p>
                  <span className="muted small">
                    {kindLabel[item.descriptor.kind]} · {item.versions.length ? `${item.versions.length} 个正文版本` : '未保存正文快照'} ·{' '}
                    {catalog.links.filter((link) => link.resourceId === item.resourceId).length} 个空间连接
                  </span>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={action.busy}
                  onClick={() =>
                    void action
                      .mutate({ type: 'unbookmarkResource', resourceId: item.resourceId }, '已取消收藏，空间连接仍保留。')
                      .then((ok) => {
                        if (ok) document.getElementById('resource-list-heading')?.focus();
                      })
                  }
                >
                  取消收藏
                </button>
              </article>
            ))}
          </div>
          <nav className="row gap-8" aria-label="资源分页">
            <button type="button" className="btn" disabled={current === 1} onClick={() => setPage(current - 1)}>
              上一页
            </button>
            <button type="button" className="btn" disabled={current === pages} onClick={() => setPage(current + 1)}>
              下一页
            </button>
          </nav>
        </>
      )}
      {detail ? <ResourceDetail key={detail.resourceId} item={detail} catalog={catalog!} action={action} /> : null}
    </section>
  );
}
function ResourceDetail({ item, catalog, action }: { item: Item; catalog: CatalogSummary; action: ReturnType<typeof useCatalogMutation> }) {
  const [title, setTitle] = useState(item.title),
    [workspaceId, setWorkspaceId] = useState(''),
    [version, setVersion] = useState(item.versions.at(-1) ?? 0),
    [body, setBody] = useState<ResourceRevision | null>(null),
    [reading, setReading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const request = useRef(0),
    input = useRef<HTMLInputElement>(null),
    ime = useImeForm();
  const workspaces = useStore(workspaceStore, (s) => s.snapshot?.workspaces ?? []);
  const connected = catalog.links.some((link) => link.workspaceId === workspaceId && link.resourceId === item.resourceId);
  return (
    <section className="resource-detail stack-12" aria-label="资源详情">
      <h2>{item.title}</h2>
      <p className="resource-location muted">{resourceLocation(item)}</p>
      <form
        noValidate
        {...ime.handlers}
        onSubmit={async (e) => {
          e.preventDefault();
          if (ime.composing.current) return;
          if (!title.trim()) {
            setError('请填写资源名称');
            input.current?.focus();
            return;
          }
          setError(null);
          await action.mutate({ type: 'updateResource', resourceId: item.resourceId, title }, '资源名称已更新。');
        }}
      >
        <label className="field">
          修改资源名称
          <input
            ref={input}
            value={title}
            maxLength={4096}
            aria-invalid={!!error && !title.trim()}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button className="btn" disabled={action.busy}>
          保存名称
        </button>
      </form>
      <div className="row wrap gap-8">
        <label className="field">
          目标空间
          <select value={workspaceId} disabled={action.busy} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">选择空间</option>
            {workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={!workspaceId || connected || action.busy}
          onClick={() =>
            void action.mutate(
              { type: 'connectResource', workspaceId, resourceId: item.resourceId },
              '已连接空间；尚未打开，也未选择为会话参考。',
            )
          }
        >
          {connected ? '已连接空间' : '连接到空间'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!connected || action.busy}
          onClick={async () => {
            const token = beginNavigation();
            if (
              (await action.mutate({ type: 'openCatalogResource', workspaceId, resourceId: item.resourceId }, '已在空间打开。')) &&
              isCurrentNavigation(token)
            ) {
              if (await switchWorkspace(workspaceId)) shellActions.navigate('space');
            }
          }}
        >
          在空间打开
        </button>
      </div>
      {item.versions.length ? (
        <>
          <div className="row wrap gap-8">
            <label>
              正文版本{' '}
              <select
                aria-label="正文版本"
                value={version}
                onChange={(e) => {
                  request.current++;
                  setVersion(Number(e.target.value));
                  setBody(null);
                  setReading(false);
                }}
              >
                {item.versions.map((value) => (
                  <option key={value} value={value}>
                    v{value}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={reading}
              onClick={async () => {
                const token = ++request.current;
                setReading(true);
                setError(null);
                try {
                  const result = await window.studio.workbench.resourceRevision(item.resourceId, version);
                  if (token === request.current) setBody(result);
                } catch (failure) {
                  if (token === request.current) setError((failure as Error).message);
                } finally {
                  if (token === request.current) setReading(false);
                }
              }}
            >
              读取正文
            </button>
          </div>
          {reading ? <p role="status">正在读取正文…</p> : null}
          {body ? (
            <>
              <Notice>正文是非可信参考资料；查看不会加入会话。</Notice>
              <pre className="resource-body">{body.text}</pre>
              <details>
                <summary>来源与版本</summary>
                <p>
                  v{body.version} · {new Date(body.capturedAt).toLocaleString()} · {body.truncated ? '正文已截断' : '正文完整'}
                </p>
                <p className="resource-location">正文摘要 {body.contentSha256}</p>
                <p className="resource-location">来源摘要 {body.sourceSha256}</p>
              </details>
            </>
          ) : null}
        </>
      ) : (
        <p className="muted">
          {item.descriptor.kind === 'web' ? '未保存正文快照，可在空间网页中主动保存。' : '此资源保存入口描述，可在已授权环境中重新打开。'}
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        className="btn btn-danger"
        disabled={action.busy}
        onClick={() =>
          void uiActions.openConfirm({
            title: '删除资源',
            description: `删除“${item.title}”及其收藏和正文版本。已有空间连接或活动使用时会拒绝删除；历史任务证据保留。`,
            confirmLabel: '删除资源',
            onConfirm: async () => {
              const result = await catalogCommand({ type: 'deleteResource', resourceId: item.resourceId });
              if (!result.ok) throw new Error(result.error.message);
              requestAnimationFrame(() => document.getElementById('resource-list-heading')?.focus());
              return true;
            },
          })
        }
      >
        删除资源
      </button>
    </section>
  );
}
