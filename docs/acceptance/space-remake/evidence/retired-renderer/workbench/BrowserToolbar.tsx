import { useEffect, useRef, useState } from 'react';
import { Notice } from '../components/Badges';
import { Icon } from '../components/Icon';
import { ResourceFeedback } from '../components/ResourceFeedback';
import { chatStore } from '../state/chat';
import { resourceActions, resourceMutationBlock, resourcesStore } from '../state/resources';
import { shellActions, shellStore } from '../state/shell';
import { useStore } from '../lib/store';
import { track } from '../state/errors';
import { previewStore } from '../state/preview';
import { uiStore } from '../state/ui';

/** Browser 区工具栏：前进后退、刷新、地址、选择模式与 CDP 状态。 */
export function BrowserToolbar() {
  const preview = useStore(previewStore, (p) => p);
  const focusTick = useStore(uiStore, (s) => s.addressFocusTick);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const scope = useStore(shellStore, (state) => state.activeScope);
  const spaceId = scope.kind === 'space' ? scope.spaceId : null;
  const chat = useStore(chatStore, (state) => state);
  const pending = useStore(resourcesStore, (state) => (spaceId ? state.pending[spaceId] : false));
  const block = spaceId ? resourceMutationBlock(chat, spaceId) : '进入空间后可加入网页。';
  const publicPage = preview?.page.url.startsWith('https://') ?? false;
  const captureDisabled = !spaceId || !!block || pending || !publicPage || !!preview?.loading || !!preview?.loadError;
  useEffect(() => {
    if (spaceId) void resourceActions.load(spaceId);
  }, [spaceId]);
  // 编辑期间显示草稿；不编辑时始终显示页面当前地址。
  const [draft, setDraft] = useState<string | null>(null);
  const currentUrl = preview?.page.url ?? '';
  const address = draft ?? currentUrl;

  useEffect(() => {
    if (focusTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const api = window.studio.preview;
  const picking = preview?.picking ?? false;

  return (
    <div className="browser-chrome">
      <div className="browser-toolbar">
        <button
          type="button"
          className="icon-btn"
          aria-label="后退"
          disabled={!preview?.canGoBack}
          onClick={() => void track('后退', api.goBack())}
        >
          <Icon name="back" size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="前进"
          disabled={!preview?.canGoForward}
          onClick={() => void track('前进', api.goForward())}
        >
          <Icon name="forward" size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label="刷新页面（⌘R）" onClick={() => void track('刷新页面', api.reload())}>
          <Icon name="reload" size={15} className={preview?.loading ? 'spin' : undefined} />
        </button>
        <form
          className="address"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (composing.current) return;
            setDraft(null);
            inputRef.current?.blur();
            void track('打开地址', api.navigate(address.trim()));
          }}
        >
          <Icon name="lock" size={13} />
          <label htmlFor="address-input" className="sr-only">
            页面地址
          </label>
          <input
            id="address-input"
            ref={inputRef}
            value={address}
            spellCheck={false}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                setDraft(null);
                inputRef.current?.blur();
              }
            }}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        <button
          type="button"
          className={picking ? 'btn btn-active' : 'btn'}
          aria-pressed={picking}
          onClick={() => void track(picking ? '取消选择' : '开始选择元素', picking ? api.cancelPick() : api.startPick())}
        >
          <Icon name="target" size={14} />
          {picking ? '选择中 · Esc 取消' : '选择元素'}
        </button>
        <span className={preview?.cdp.state === 'detached' ? 'chip chip-warn' : 'chip'} title="同页控制通道（CDP）状态">
          CDP {preview?.cdp.state === 'attached' ? '已附着' : preview?.cdp.state === 'detached' ? '已断开' : '未附着'}
        </span>
        {preview && preview.consoleIssueCount > 0 ? <span className="chip chip-warn">页面错误 {preview.consoleIssueCount}</span> : null}
      </div>
      <div className="resource-browser-actions row wrap gap-8">
        <span className="muted small">{publicPage ? '公开网页 · 只读文档' : '在地址栏打开公开 HTTPS 网页后可加入空间'}</span>
        <button
          type="button"
          className="btn"
          disabled={captureDisabled}
          aria-busy={pending}
          onClick={() => {
            if (spaceId && preview) void resourceActions.capture(spaceId, preview.page);
          }}
        >
          加入空间
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => shellActions.navigate('resources')}>
          查看空间资源
        </button>
        {block ? <span className="muted small">{block}</span> : null}
      </div>
      {spaceId ? <ResourceFeedback spaceId={spaceId} /> : null}
      {preview?.cdp.state === 'detached' ? (
        <Notice tone="warn">
          CDP 已断开（{preview.cdp.reason}），页面自动操作已暂停。重新附着后需要重新采集现场。
          <button type="button" className="btn btn-small" onClick={() => void track('重新附着 CDP', api.reattachCdp())}>
            重新附着
          </button>
        </Notice>
      ) : null}
      {preview?.loadError ? (
        <Notice tone="bad">
          页面加载失败：{preview.loadError.description}（{preview.loadError.code}）<code>{preview.loadError.url}</code>
        </Notice>
      ) : null}
      {preview?.blockedNavigation ? (
        <Notice tone="warn">已拦截导航到 {preview.blockedNavigation}：只允许演示页面或通过安全检查的公开 HTTPS 文档。</Notice>
      ) : null}
    </div>
  );
}
