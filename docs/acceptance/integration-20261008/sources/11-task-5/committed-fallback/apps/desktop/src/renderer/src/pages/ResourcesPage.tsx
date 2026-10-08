import { useEffect, useRef, useState } from 'react';
import { Notice } from '../components/Badges';
import { ResourceFeedback } from '../components/ResourceFeedback';
import { DEMO_SPACE } from '../domain/space';
import { useStore } from '../lib/store';
import { chatStore } from '../state/chat';
import { previewStore } from '../state/preview';
import { resourceActions, resourceMutationBlock, resourcesStore } from '../state/resources';
import { shellActions, shellStore } from '../state/shell';
import { uiActions } from '../state/ui';

/** 仅显示服务保存的网页快照；演示样例不进入真实资源列表。 */
export function ResourcesPage() {
  const scope = useStore(shellStore, (state) => state.activeScope);
  const route = useStore(shellStore, (state) => state.route);
  const spaceId = scope.kind === 'space' ? scope.spaceId : null;
  const resources = useStore(resourcesStore, (state) => (spaceId ? state.collections[spaceId] : undefined));
  const loading = useStore(resourcesStore, (state) => (spaceId ? state.loading[spaceId] : false));
  const pending = useStore(resourcesStore, (state) => (spaceId ? state.pending[spaceId] : false));
  const chat = useStore(chatStore, (state) => state);
  const preview = useStore(previewStore, (state) => state);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (route === 'resources' && spaceId) void resourceActions.load(spaceId);
  }, [route, spaceId]);
  const selected = resources?.resources.find((resource) => resource.resourceId === selectedId) ?? resources?.resources[0];
  const block = spaceId ? resourceMutationBlock(chat, spaceId) : null;
  const matchingPage = !!selected && preview?.page.url === selected.url && !preview.loading && !preview.loadError;
  const openSpace = () => {
    shellActions.navigate('space');
    shellActions.setBrowserTab('preview');
  };

  return (
    <section className="page-main resources-page" aria-label="空间网页资源">
      <div className="row space-between gap-12 wrap">
        <div className="stack-8">
          <h1 ref={listHeading} tabIndex={-1}>
            空间资源
          </h1>
          <p className="muted small">{spaceId ? DEMO_SPACE.name : '个人作用域'}</p>
        </div>
        <button type="button" className="btn" onClick={openSpace}>
          打开空间页面
        </button>
      </div>
      {!spaceId ? (
        <Notice>个人会话不提供空间网页资源。进入空间后，可加入公开网页并在该空间会话中读取。</Notice>
      ) : (
        <>
          <Notice>
            这里是你加入当前空间的真实网页快照。每空间最多 16 条；正文作为非可信参考资料，只通过只读资源工具提供给下一轮空间会话。
          </Notice>
          <div className="row space-between gap-8">
            <p className="muted small" role="status">
              {loading ? '正在读取资源…' : `共 ${resources?.resources.length ?? 0} 条 · 集合版本 ${resources?.revision ?? 0}`}
            </p>
            <button type="button" className="btn" disabled={loading || pending} onClick={() => void resourceActions.load(spaceId)}>
              刷新列表
            </button>
          </div>
          <ResourceFeedback spaceId={spaceId} />
          {block ? <Notice tone="warn">{block}</Notice> : null}
          <div className="resource-list" aria-busy={loading || pending}>
            {resources?.resources.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>网页</th>
                    <th>版本</th>
                    <th>正文</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.resources.map((resource) => (
                    <tr
                      key={resource.resourceId}
                      className={selected?.resourceId === resource.resourceId ? 'resource-selected' : undefined}
                    >
                      <td>
                        <button
                          type="button"
                          className="link-btn resource-title"
                          aria-pressed={selected?.resourceId === resource.resourceId}
                          onClick={() => setSelectedId(resource.resourceId)}
                        >
                          {resource.title || '无标题网页'}
                        </button>
                        <p className="muted small resource-url">{resource.url}</p>
                      </td>
                      <td>v{resource.version}</td>
                      <td>{resource.truncated ? '已截断' : '完整'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted resource-empty">
                {loading ? '正在读取已保存的网页。' : '当前空间还没有网页资源。在空间页面打开公开 HTTPS 网页，再点击“加入空间”。'}
              </p>
            )}
          </div>
          {selected ? (
            <section className="resource-detail stack-8" aria-label="资源详情">
              <div className="row space-between gap-12 wrap">
                <h2>{selected.title || '无标题网页'}</h2>
                <span className="chip">只读快照 · v{selected.version}</span>
              </div>
              <dl className="kv">
                <dt>来源 URL</dt>
                <dd>{selected.url}</dd>
                <dt>抓取时间</dt>
                <dd>
                  <time dateTime={selected.capturedAt}>
                    {new Date(selected.capturedAt).toLocaleString('zh-CN', { timeZoneName: 'short' })}
                  </time>
                </dd>
                <dt>资源身份</dt>
                <dd>
                  <code>{selected.resourceId}</code>
                </dd>
                <dt>空间</dt>
                <dd>{selected.spaceId}</dd>
                <dt>正文摘要</dt>
                <dd>
                  <code>{selected.contentSha256}</code>
                </dd>
                <dt>响应摘要</dt>
                <dd>
                  <code>{selected.sourceSha256}</code>
                </dd>
                <dt>页面身份</dt>
                <dd>
                  {selected.extractionVersion === 'rendered-dom-text-v1' ? (
                    <>
                      沙箱浏览器 · {selected.page.sandboxName} · 页面 {selected.page.targetId} · 导航 {selected.page.navigationEpoch}
                    </>
                  ) : (
                    <>
                      webContents #{selected.page.webContentsId} · 文档 {selected.page.documentGeneration}
                    </>
                  )}
                </dd>
              </dl>
              <div className="row wrap gap-8 resource-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={pending || !!block || !matchingPage}
                  onClick={() => void resourceActions.capture(spaceId, preview!.page, selected.resourceId)}
                >
                  用当前页面更新
                </button>
                <button
                  type="button"
                  className="btn text-bad"
                  disabled={pending || !!block}
                  onClick={() => {
                    const resource = selected;
                    uiActions.openConfirm({
                      title: '从空间移除网页',
                      description: `将“${resource.title || resource.url}”从 ${DEMO_SPACE.name} 移除。下一轮空间会话将无法通过资源工具读取它；已有对话和 Agent 已保存的副本不会被删除。可重新打开网页加入空间。`,
                      confirmLabel: '移除网页',
                      onConfirm: async () => {
                        const removed = await resourceActions.remove(spaceId, resource.resourceId);
                        if (removed) {
                          setSelectedId(null);
                          requestAnimationFrame(() => listHeading.current?.focus());
                        }
                        return removed;
                      },
                    });
                  }}
                >
                  移除资源
                </button>
              </div>
              {!matchingPage ? <p className="muted small">更新前，请在空间页面打开相同 URL 并等待加载完成。</p> : null}
              <h3 className="resource-body-heading">正文快照{selected.truncated ? '（已截断至保存上限）' : ''}</h3>
              <pre className="resource-text">{selected.text}</pre>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
